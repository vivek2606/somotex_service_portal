// Data-layer operations. Every function takes the database explicitly so the
// same code runs in the app and in tests.

import {
  evaluateJob,
  expectedConsumable,
  expectedRefrigerant,
  issuePlan,
  type IssuePlanLine,
  toGrams,
  type MaterialUsage,
  type PriorCharge,
} from '../lib/consumption';
import type { StockRow } from '../lib/csv';
import { newId, runtime, SYNCED_TABLES, type ServiceDB } from './db';
import type { AppSettings } from './settings';
import { GAS_TYPES } from './types';
import type {
  CallOutcome,
  Complaint,
  ComplaintStatus,
  ConsumptionAlert,
  Customer,
  InventoryItem,
  LogKind,
  StockMovement,
} from './types';

const nowIso = () => runtime.now().toISOString();

/** Prefix of ticket numbers waiting for the server to assign the real one. */
export const TEMP_TICKET = 'TMP-';

export const isTempTicket = (t: string) => t.startsWith(TEMP_TICKET);

/** Unguessable token for the customer's status and feedback links. */
export function newPublicToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Gives an older complaint a link token if it doesn't have one. */
export async function ensurePublicToken(db: ServiceDB, complaintId: string): Promise<string> {
  const c = await getComplaint(db, complaintId);
  if (c.publicToken) return c.publicToken;
  const token = newPublicToken();
  await db.complaints.update(complaintId, { publicToken: token });
  return token;
}

export async function nextTicketNo(db: ServiceDB, prefix: string, at = runtime.now()): Promise<string> {
  // With a shared server, numbers are assigned centrally so two PCs never
  // issue the same one; until then the ticket carries a temporary number.
  if (runtime.cloud) return TEMP_TICKET + crypto.randomUUID().slice(0, 13).toUpperCase();
  const stem = `${prefix}-${at.getFullYear()}-`;
  const existing = await db.complaints.where('ticketNo').between(stem, stem + '￿').primaryKeys();
  const numbers = (await db.complaints.bulkGet(existing)).map((c) => Number(c!.ticketNo.slice(stem.length)) || 0);
  const seq = Math.max(0, ...numbers) + 1;
  return stem + String(seq).padStart(5, '0');
}

/** Who is making a change: the signed-in person, or the system itself. */
export type Actor = Pick<AppSettings, 'currentUser' | 'currentUserEmail'> | 'System';

const actorName = (a: Actor) => (a === 'System' ? 'System' : a.currentUser);
const actorEmail = (a: Actor) => (a === 'System' ? undefined : a.currentUserEmail);

export async function addLog(db: ServiceDB, complaintId: string, kind: LogKind, text: string, by: Actor) {
  await db.logs.add({ id: newId(), complaintId, kind, text, by: actorName(by), byEmail: actorEmail(by), at: nowIso() });
}

export type NewComplaint = Omit<
  Complaint,
  'id' | 'ticketNo' | 'status' | 'createdAt' | 'updatedAt' | 'dueAt' | 'customerId' | 'loggedBy'
> & { customerId?: string; customer?: Omit<Customer, 'id' | 'createdAt'> };

export async function createComplaint(db: ServiceDB, settings: AppSettings, input: NewComplaint): Promise<string> {
  return db.transaction('rw', [db.customers, db.complaints, db.logs, db.technicians], async () => {
    let customerId = input.customerId;
    if (!customerId) {
      if (!input.customer) throw new Error('A customer is required');
      customerId = newId();
      await db.customers.add({ ...input.customer, id: customerId, createdAt: nowIso() });
    }
    const created = runtime.now();
    const due = new Date(created.getTime() + settings.slaHours[input.priority] * 3600000);
    const { customer: _customer, ...rest } = input;
    void _customer;
    const complaint: Complaint = {
      ...rest,
      id: newId(),
      customerId,
      ticketNo: await nextTicketNo(db, settings.ticketPrefix, created),
      status: input.technicianId ? 'Assigned' : 'Registered',
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      dueAt: due.toISOString(),
      loggedBy: settings.currentUser,
      loggedByEmail: settings.currentUserEmail,
      publicToken: newPublicToken(),
    };
    const id = complaint.id;
    await db.complaints.add(complaint);
    await addLog(db, id, 'status', `Complaint registered, priority ${input.priority}`, settings);
    if (input.customerStatement?.trim()) {
      await db.logs.add({
        id: newId(),
        complaintId: id,
        kind: 'customer',
        outcome: 'Customer reached',
        text: `Customer said: “${input.customerStatement.trim()}”`,
        by: settings.currentUser,
      byEmail: settings.currentUserEmail,
        at: complaint.createdAt,
      });
    }
    if (input.technicianId) {
      const tech = await db.technicians.get(input.technicianId);
      await addLog(db, id, 'assignment', `Assigned to ${tech?.name ?? 'technician'}`, settings);
    }
    return id;
  });
}

/** Records a call with the customer and what they said. */
export async function logCustomerContact(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  outcome: CallOutcome,
  response: string,
) {
  await db.logs.add({
    id: newId(),
    complaintId,
    kind: 'customer',
    outcome,
    text: response.trim() || outcome,
    by: settings.currentUser,
      byEmail: settings.currentUserEmail,
    at: nowIso(),
  });
  await db.complaints.update(complaintId, { updatedAt: nowIso() });
}

export async function assignTechnician(db: ServiceDB, settings: AppSettings, complaintId: string, technicianId: string) {
  const c = await getComplaint(db, complaintId);
  const tech = await db.technicians.get(technicianId);
  const status: ComplaintStatus = c.status === 'Registered' ? 'Assigned' : c.status;
  await db.complaints.update(complaintId, { technicianId, status, updatedAt: nowIso() });
  await addLog(db, complaintId, 'assignment', `Assigned to ${tech?.name ?? 'technician'}`, settings);
  // Alerts carry the technician, so refresh them.
  await reevaluate(db, settings, complaintId);
}

export const OPEN_STATUSES: ComplaintStatus[] = ['Registered', 'Assigned', 'In Progress', 'Awaiting Parts'];

export function isOpen(c: Pick<Complaint, 'status'>) {
  return OPEN_STATUSES.includes(c.status);
}

export async function setStatus(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  status: ComplaintStatus,
  note?: string,
) {
  const c = await getComplaint(db, complaintId);
  if (status === 'Closed' || status === 'Resolved') {
    if (!c.jobType) throw new Error('Record the job type before resolving or closing');
    if (!c.resolution?.trim()) throw new Error('Record the resolution before resolving or closing');
  }
  const at = nowIso();
  const patch: Partial<Complaint> = { status, updatedAt: at };
  if (status === 'Resolved' && !c.resolvedAt) patch.resolvedAt = at;
  if (status === 'Closed') {
    patch.closedAt = at;
    patch.closedBy = settings.currentUser;
    patch.closedByEmail = settings.currentUserEmail;
    if (!c.resolvedAt) patch.resolvedAt = at;
  }
  if (status !== 'Closed') {
    patch.closedBy = undefined;
    patch.closedByEmail = undefined;
  }
  if (OPEN_STATUSES.includes(status)) {
    patch.closedAt = undefined;
    patch.resolvedAt = undefined;
  }
  await db.complaints.update(complaintId, patch);
  const reopened = !isOpen(c) && OPEN_STATUSES.includes(status);
  await addLog(
    db,
    complaintId,
    'status',
    `${reopened ? 'Re-opened' : 'Status'}: ${c.status} → ${status}${note ? ` (${note})` : ''}`,
    settings,
  );
  if (status === 'Closed' || status === 'Resolved') await reevaluate(db, settings, complaintId);
}

export async function updateJobDetails(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  patch: Partial<
    Pick<
      Complaint,
      | 'jobType'
      | 'pipeLengthM'
      | 'brazedJoints'
      | 'brazingMethod'
      | 'nitrogenPurged'
      | 'flushedPipeM'
      | 'pressureTested'
      | 'recoveredG'
      | 'rootCause'
      | 'confirmedCauseId'
      | 'resolution'
      | 'customerFeedback'
      | 'serviceCharge'
      | 'equipment'
      | 'branch'
      | 'leakPoints'
      | 'supplyVoltage'
      | 'stabiliser'
      | 'powerSource'
      | 'feedbackComment'
    >
  >,
) {
  const full: Partial<Complaint> = { ...patch, updatedAt: nowIso() };
  if ('customerFeedback' in patch) {
    const c = await getComplaint(db, complaintId);
    // A rating the customer gave through their link stays as they gave it.
    if (c.feedbackVia === 'customer') {
      delete full.customerFeedback;
      delete full.feedbackComment;
    } else if (patch.customerFeedback !== c.customerFeedback) {
      full.feedbackAt = patch.customerFeedback ? nowIso() : undefined;
      full.feedbackVia = patch.customerFeedback ? 'helpdesk' : undefined;
    }
  }
  await db.complaints.update(complaintId, full);
  await reevaluate(db, settings, complaintId);
}

export async function getComplaint(db: ServiceDB, id: string): Promise<Complaint> {
  const c = await db.complaints.get(id);
  if (!c) throw new Error(`Complaint ${id} not found`);
  return c;
}

// ---------------------------------------------------------------- inventory

export function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** Records a stock movement and updates the local stock figure. */
export async function recordMovement(db: ServiceDB, m: Omit<StockMovement, 'id' | 'at'>) {
  const item = await db.items.get(m.itemId);
  if (!item) throw new Error('Item not found');
  const newStock = round(item.stock + m.qty);
  if (newStock < 0) {
    throw new Error(`Not enough stock of ${item.name}: ${item.stock} ${item.unit} available`);
  }
  // Stock is derived from the ledger; this keeps the local figure current.
  await db.items.update(m.itemId, { stock: newStock });
  await db.movements.add({ ...m, id: newId(), at: nowIso() });
  return item;
}

/** Recomputes stock for items from their movement ledger. */
export async function recomputeStock(db: ServiceDB, itemIds: Iterable<string>) {
  for (const itemId of new Set(itemIds)) {
    let total = 0;
    await db.movements.where('itemId').equals(itemId).each((m) => {
      // Movements the server refused never happened.
      if (m._dirty !== 2) total += m.qty;
    });
    await db.items.update(itemId, { stock: round(total) });
  }
}

export async function issueToComplaint(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  itemId: string,
  qty: number,
  note?: string,
) {
  if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
  const c = await getComplaint(db, complaintId);
  const check = await checkIssue(db, settings, c, itemId, qty);
  if (check.overLimit && !note?.trim()) {
    throw new Error(
      `This takes the job to ${check.totalAfter} ${check.plan!.unit}, above the ${check.plan!.limit} ${check.plan!.unit} budget. Enter a reason to issue more.`,
    );
  }
  await db.transaction('rw', db.items, db.movements, db.logs, async () => {
    const item = await recordMovement(db, {
      itemId,
      kind: 'Issue',
      qty: -qty,
      complaintId,
      technicianId: c.technicianId,
      note,
      by: settings.currentUser,
      byEmail: settings.currentUserEmail,
    });
    await addLog(
      db,
      complaintId,
      'material',
      `Issued ${qty} ${item.unit} ${item.name}${check.overLimit ? ` (over budget: ${note})` : note ? ` (${note})` : ''}`,
      settings,
    );
  });
  return reevaluate(db, settings, complaintId);
}

export interface IssueCheck {
  plan?: IssuePlanLine;
  alreadyUsed: number;
  totalAfter: number;
  overLimit: boolean;
}

/** Compares a proposed issue against the job's gas budget. */
export async function checkIssue(
  db: ServiceDB,
  settings: AppSettings,
  c: Complaint,
  itemId: string,
  qty: number,
): Promise<IssueCheck> {
  const item = await db.items.get(itemId);
  if (!item) throw new Error('Item not found');
  const usage = await materialUsage(db, c.id!);
  const alreadyUsed = usage.find((u) => u.item.id === itemId)?.qty ?? 0;
  const totalAfter = round(alreadyUsed + qty);
  const plan = GAS_TYPES.includes(item.type) ? issuePlan(item, c, settings.norms) : undefined;
  return { plan, alreadyUsed, totalAfter, overLimit: !!plan && totalAfter > plan.limit };
}

export async function returnFromComplaint(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  itemId: string,
  qty: number,
  note?: string,
) {
  if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
  const usage = await materialUsage(db, complaintId);
  const used = usage.find((u) => u.item.id === itemId);
  if (!used || used.qty < qty) throw new Error('You can’t return more than was issued to this job');
  const c = await getComplaint(db, complaintId);
  await db.transaction('rw', db.items, db.movements, db.logs, async () => {
    const item = await recordMovement(db, {
      itemId,
      kind: 'Return',
      qty,
      complaintId,
      technicianId: c.technicianId,
      note,
      by: settings.currentUser,
      byEmail: settings.currentUserEmail,
    });
    await addLog(db, complaintId, 'material', `Returned ${qty} ${item.unit} ${item.name} to store`, settings);
  });
  return reevaluate(db, settings, complaintId);
}

export async function receiveStock(
  db: ServiceDB,
  settings: AppSettings,
  itemId: string,
  qty: number,
  reference?: string,
  unitCost?: number,
) {
  if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
  await db.transaction('rw', db.items, db.movements, async () => {
    await recordMovement(db, { itemId, kind: 'Receipt', qty, reference, by: settings.currentUser, byEmail: settings.currentUserEmail });
    if (unitCost !== undefined && unitCost >= 0) await db.items.update(itemId, { unitCost });
  });
}

/** Sets stock to a physically counted quantity, recording the difference. */
export async function adjustStock(db: ServiceDB, settings: AppSettings, itemId: string, countedQty: number, note: string) {
  if (!(countedQty >= 0)) throw new Error('Counted quantity must be zero or more');
  await db.transaction('rw', db.items, db.movements, async () => {
    const item = await db.items.get(itemId);
    if (!item) throw new Error('Item not found');
    const delta = round(countedQty - item.stock);
    if (delta === 0) return;
    await recordMovement(db, { itemId, kind: 'Adjustment', qty: delta, note, by: settings.currentUser, byEmail: settings.currentUserEmail });
  });
}

/** Net quantity consumed per item on a complaint (issues − returns). */
export async function materialUsage(db: ServiceDB, complaintId: string): Promise<MaterialUsage[]> {
  const moves = await db.movements.where('complaintId').equals(complaintId).toArray();
  const net = new Map<string, number>();
  for (const m of moves) {
    if ((m.kind !== 'Issue' && m.kind !== 'Return') || m._dirty === 2) continue;
    net.set(m.itemId, round((net.get(m.itemId) ?? 0) - m.qty));
  }
  const items = await db.items.bulkGet([...net.keys()]);
  return items
    .filter((i): i is InventoryItem => !!i)
    .map((item) => ({ item, qty: net.get(item.id)! }))
    .filter((u) => u.qty > 0);
}

export interface StockImportResult {
  created: number;
  updated: number;
  stockSet: number;
}

/**
 * Upserts items from a stock sheet by SKU. Where the sheet gives a stock
 * figure, the item is brought to that quantity through a ledger entry, so
 * the movement history stays complete.
 */
export async function importStockRows(db: ServiceDB, settings: AppSettings, rows: StockRow[]): Promise<StockImportResult> {
  const result: StockImportResult = { created: 0, updated: 0, stockSet: 0 };
  await db.transaction('rw', db.items, db.movements, async () => {
    for (const r of rows) {
      const { stock, ...fields } = r;
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<InventoryItem>;
      let item = await db.items.where('sku').equals(r.sku).first();
      if (item) {
        await db.items.update(item.id, clean);
        result.updated++;
      } else {
        const id = newId();
        await db.items.add({
          id,
          reorderLevel: 0,
          unitCost: 0,
          ...clean,
          sku: r.sku,
          name: r.name,
          type: r.type,
          unit: r.unit,
          stock: 0,
          active: true,
        });
        item = await db.items.get(id);
        result.created++;
      }
      if (stock !== undefined && stock >= 0 && item) {
        const delta = round(stock - item.stock);
        if (delta !== 0) {
          await recordMovement(db, {
            itemId: item.id,
            kind: item.stock === 0 && delta > 0 ? 'Receipt' : 'Adjustment',
            qty: delta,
            reference: 'Stock sheet import',
            by: settings.currentUser,
      byEmail: settings.currentUserEmail,
          });
          result.stockSet++;
        }
      }
    }
  });
  return result;
}

// ------------------------------------------------------------ intelligence

async function priorChargesFor(db: ServiceDB, c: Complaint): Promise<PriorCharge[]> {
  const serial = c.equipment.serialNo?.trim();
  if (!serial) return [];
  const others = await db.complaints.where('equipment.serialNo').equals(serial).toArray();
  const result: PriorCharge[] = [];
  for (const o of others) {
    if (o.id === c.id || o.equipment.brand !== c.equipment.brand) continue;
    if (new Date(o.createdAt) >= new Date(c.createdAt)) continue;
    const usage = await materialUsage(db, o.id);
    if (usage.some((u) => u.item.type === 'Refrigerant')) {
      result.push({ complaintId: o.id, ticketNo: o.ticketNo, at: o.createdAt });
    }
  }
  return result;
}

/**
 * Recomputes consumption alerts for a complaint. Unacknowledged alerts are
 * replaced; an alert the team already acknowledged is not raised again unless
 * the consumption figure changes.
 */
export async function reevaluate(db: ServiceDB, settings: AppSettings, complaintId: string): Promise<ConsumptionAlert[]> {
  const c = await getComplaint(db, complaintId);
  const usage = await materialUsage(db, complaintId);
  const prior = await priorChargesFor(db, c);
  const evaluated = evaluateJob(c, usage, settings.norms, prior);

  return db.transaction('rw', db.alerts, db.logs, async () => {
    const existing = (await db.alerts.where('complaintId').equals(complaintId).toArray()).filter((a) => !a.cleared);
    const acked = existing.filter((a) => a.acknowledged);
    const previousOpen = existing.filter((a) => !a.acknowledged);
    const same = (a: ConsumptionAlert, e: (typeof evaluated)[number]) =>
      a.code === e.code && a.itemId === e.itemId && a.actual === e.actual;

    const current: ConsumptionAlert[] = [];
    const kept = new Set<string>();
    for (const e of evaluated) {
      if (acked.some((a) => same(a, e))) continue;
      const open = previousOpen.find((a) => same(a, e));
      if (open) {
        // Unchanged: keep the existing alert rather than churning rows.
        kept.add(open.id);
        if (open.technicianId !== c.technicianId || open.message !== e.message) {
          await db.alerts.update(open.id, { technicianId: c.technicianId, message: e.message, severity: e.severity, expected: e.expected });
        }
        current.push({ ...open, technicianId: c.technicianId, message: e.message, severity: e.severity, expected: e.expected });
        continue;
      }
      const alert: ConsumptionAlert = {
        ...e,
        id: newId(),
        complaintId,
        technicianId: c.technicianId,
        at: nowIso(),
        acknowledged: false,
      };
      await db.alerts.add(alert);
      current.push(alert);
      if (e.severity !== 'info') await addLog(db, complaintId, 'alert', `⚠ ${e.message}`, 'System');
    }
    // Alerts that no longer apply are cleared, not deleted, so every device hears about it.
    for (const a of previousOpen) {
      if (!kept.has(a.id)) await db.alerts.update(a.id, { cleared: true });
    }
    return current;
  });
}

export async function acknowledgeAlert(db: ServiceDB, settings: AppSettings, alertId: string, note: string) {
  const a = await db.alerts.get(alertId);
  if (!a) return;
  await db.alerts.update(alertId, { acknowledged: true, ackNote: note });
  await addLog(db, a.complaintId, 'note', `Alert reviewed: ${note || 'no comment'}`, settings);
}

export interface GasJobStat {
  complaintId: string;
  ticketNo: string;
  technicianId?: string;
  jobType?: string;
  brand: string;
  branch?: string;
  itemId: string;
  itemName: string;
  itemType: InventoryItem['type'];
  unit: string;
  /** Expected quantity (item unit); undefined when there is no baseline. */
  expected?: number;
  actual: number;
  unitCost: number;
  at: string;
}

/** Gas / budgeted-consumable use vs expectation on every job that used any. */
export async function gasJobStats(db: ServiceDB, settings: AppSettings, sinceIso?: string): Promise<GasJobStat[]> {
  const moves = await db.movements.where('kind').anyOf('Issue', 'Return').toArray();
  const items = new Map((await db.items.toArray()).map((i) => [i.id, i]));
  const net = new Map<string, number>();
  for (const m of moves) {
    const item = items.get(m.itemId);
    if (!item || !GAS_TYPES.includes(item.type) || m.complaintId === undefined) continue;
    const key = `${m.complaintId}|${m.itemId}`;
    net.set(key, round((net.get(key) ?? 0) - m.qty));
  }
  const ids = [...new Set([...net.keys()].map((k) => k.split('|')[0]))];
  const complaints = new Map(
    (await db.complaints.bulkGet(ids)).filter((c): c is Complaint => !!c).map((c) => [c.id, c]),
  );
  const stats: GasJobStat[] = [];
  for (const [key, actual] of net) {
    if (actual <= 0) continue;
    const [cid, iid] = key.split('|');
    const c = complaints.get(cid);
    const item = items.get(iid)!;
    if (!c) continue;
    const at = c.closedAt ?? c.createdAt;
    if (sinceIso && at < sinceIso) continue;
    let expected: number | undefined;
    if (item.type === 'Refrigerant') {
      const exp = expectedRefrigerant(c.equipment, c.jobType, c.pipeLengthM, settings.norms);
      const factor = toGrams(1, item.unit);
      if (factor && (exp.basis !== 'unknown' || exp.expectedG > 0)) expected = exp.expectedG / factor;
    } else {
      expected = expectedConsumable(item, c)?.expected;
    }
    stats.push({
      complaintId: cid,
      ticketNo: c.ticketNo,
      technicianId: c.technicianId,
      jobType: c.jobType,
      brand: c.equipment.brand,
      branch: c.branch,
      itemId: iid,
      itemName: item.name,
      itemType: item.type,
      unit: item.unit,
      expected,
      actual,
      unitCost: item.unitCost,
      at,
    });
  }
  return stats;
}

/** Past confirmed causes (cause id → count), to improve suggestions. */
export async function confirmedCauseCounts(db: ServiceDB): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await db.complaints.where('status').equals('Closed').each((c) => {
    if (c.confirmedCauseId) counts[c.confirmedCauseId] = (counts[c.confirmedCauseId] ?? 0) + 1;
  });
  return counts;
}

// ------------------------------------------------------------------ backup

const TABLES = SYNCED_TABLES;

const stripMeta = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));

export async function exportAll(db: ServiceDB) {
  const data: Record<string, unknown[]> = {};
  for (const t of TABLES) data[t] = (await db.table(t).toArray()).map(stripMeta);
  return { app: 'somotex-service-portal', version: 3, exportedAt: nowIso(), data };
}

/** Replaces all data on this device with a backup (single-device mode only). */
export async function importAll(db: ServiceDB, backup: { app?: string; version?: number; data?: Record<string, unknown[]> }) {
  if (backup.app !== 'somotex-service-portal' || !backup.data) throw new Error('This file is not a service portal backup');
  if (backup.version !== 2 && backup.version !== 3) throw new Error('This backup is from an older version of the app and can’t be restored here');
  if (runtime.cloud) throw new Error('Restoring a backup is only available in single-device mode');
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      const rows = backup.data![t];
      if (rows?.length) await db.table(t).bulkAdd(rows);
    }
  });
}
