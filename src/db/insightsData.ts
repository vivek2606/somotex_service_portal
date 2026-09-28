// Gathers the facts the Insights page works from, in one pass over the data.

import { expectedRefrigerant, toGrams, usesRefrigerant } from '../lib/consumption';
import type { JobFacts, Outflow } from '../lib/insights';
import type { ServiceDB } from './db';
import type { AppSettings } from './settings';
import type { Complaint } from './types';

const REPEAT_DAYS = 30;

/** Facts for every complaint logged since `sinceIso` (all when undefined). */
export async function loadJobFacts(db: ServiceDB, settings: AppSettings, sinceIso?: string): Promise<JobFacts[]> {
  const complaints = sinceIso ? await db.complaints.where('createdAt').aboveOrEqual(sinceIso).toArray() : await db.complaints.toArray();
  if (!complaints.length) return [];
  const ids = new Set(complaints.map((c) => c.id));
  const items = new Map((await db.items.toArray()).map((i) => [i.id, i]));
  const customers = new Map((await db.customers.toArray()).map((c) => [c.id, c]));

  // Net use per complaint and item.
  const net = new Map<string, Map<string, number>>();
  await db.movements
    .where('kind')
    .anyOf('Issue', 'Return')
    .each((m) => {
      if (!m.complaintId || !ids.has(m.complaintId) || m._dirty === 2) return;
      const per = net.get(m.complaintId) ?? new Map<string, number>();
      per.set(m.itemId, (per.get(m.itemId) ?? 0) - m.qty);
      net.set(m.complaintId, per);
    });

  // Jobs that went to "Awaiting Parts" at some point.
  const waited = new Set<string>();
  await db.logs
    .filter((l) => l.kind === 'status' && ids.has(l.complaintId) && l.text.includes('→ Awaiting Parts'))
    .each((l) => void waited.add(l.complaintId));
  for (const c of complaints) if (c.status === 'Awaiting Parts') waited.add(c.id);

  // Later complaints for the same unit, to spot jobs that came back.
  const bySerial = new Map<string, Complaint[]>();
  for (const c of await db.complaints.toArray()) {
    const sn = c.equipment.serialNo?.trim();
    if (!sn) continue;
    const k = `${c.equipment.brand}|${sn.toUpperCase()}`;
    bySerial.set(k, [...(bySerial.get(k) ?? []), c]);
  }

  return complaints.map((c) => {
    let refrigerantG = 0;
    let materialCost = 0;
    const spares: JobFacts['spares'] = [];
    for (const [itemId, qty] of net.get(c.id) ?? []) {
      const item = items.get(itemId);
      if (!item || qty <= 0) continue;
      materialCost += qty * item.unitCost;
      if (item.type === 'Refrigerant') refrigerantG += toGrams(qty, item.unit) ?? 0;
      if (item.type === 'Spare') spares.push({ itemId, name: item.name, qty });
    }
    let refrigerantBudgetG: number | undefined;
    if (usesRefrigerant(c.equipment.category) && c.jobType) {
      const exp = expectedRefrigerant(c.equipment, c.jobType, c.pipeLengthM, settings.norms);
      if (exp.basis !== 'unknown' && exp.expectedG > 0) refrigerantBudgetG = exp.expectedG;
    }
    const sn = c.equipment.serialNo?.trim();
    const closedAt = c.closedAt ?? c.resolvedAt;
    const cameBack =
      !!sn &&
      !!closedAt &&
      (bySerial.get(`${c.equipment.brand}|${sn.toUpperCase()}`) ?? []).some(
        (o) => o.id !== c.id && o.createdAt > closedAt && Date.parse(o.createdAt) - Date.parse(closedAt) <= REPEAT_DAYS * 86400000,
      );
    return {
      c,
      customer: customers.get(c.customerId),
      refrigerantG,
      refrigerantBudgetG,
      spares,
      materialCost,
      cameBack,
      waitedForParts: waited.has(c.id),
    };
  });
}

/** Refrigerant leaving the store (to jobs and branches), for the seasonal forecast. */
export async function loadRefrigerantOutflows(db: ServiceDB): Promise<{ outflows: Outflow[]; stockKg: Record<string, number> }> {
  const refrigerants = (await db.items.where('type').equals('Refrigerant').toArray()).filter((i) => i.refrigerant && i.refrigerant !== 'None');
  const byId = new Map(refrigerants.map((i) => [i.id, i]));
  const stockKg: Record<string, number> = {};
  for (const i of refrigerants) {
    const g = toGrams(i.stock, i.unit);
    if (g !== undefined) stockKg[i.refrigerant!] = (stockKg[i.refrigerant!] ?? 0) + g / 1000;
  }
  const outflows: Outflow[] = [];
  await db.movements
    .where('kind')
    .anyOf('Issue', 'Return', 'Transfer')
    .each((m) => {
      const item = byId.get(m.itemId);
      if (!item || m._dirty === 2) return;
      const g = toGrams(-m.qty, item.unit);
      if (g !== undefined) outflows.push({ at: m.at, refrigerant: item.refrigerant!, grams: g });
    });
  return { outflows, stockKg };
}
