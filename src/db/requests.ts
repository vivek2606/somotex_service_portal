// Branch requests: all stock sits in the Lagos store. A branch asks for
// parts or gas (usually for a job), the Service Head approves, Lagos
// dispatches, and the branch confirms receipt.
//
// Stock leaves Lagos at dispatch. For a job, what is sent is booked to the
// job, so its gas budget and alerts include it.

import { newId, runtime, type ServiceDB } from './db';
import { addLog, getComplaint, isOpen, recordMovement, reevaluate, setStatus } from './service';
import type { AppSettings } from './settings';
import type { BranchRequest, RequestLine } from './types';

const nowIso = () => runtime.now().toISOString();

async function getRequest(db: ServiceDB, id: string) {
  const r = await db.requests.get(id);
  if (!r) throw new Error('Request not found');
  return r;
}

export interface NewRequest {
  branch: string;
  complaintId?: string;
  lines: RequestLine[];
  reason?: string;
}

export async function createRequest(db: ServiceDB, settings: AppSettings, input: NewRequest): Promise<string> {
  const lines = input.lines.filter((l) => l.itemId && l.qty > 0);
  if (!input.branch) throw new Error('Choose the branch');
  if (!lines.length) throw new Error('Add at least one item with a quantity');
  const id = newId();
  const ref = `REQ-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const req: BranchRequest = {
    id,
    ref,
    branch: input.branch,
    complaintId: input.complaintId,
    lines,
    status: 'Requested',
    reason: input.reason?.trim() || undefined,
    requestedAt: nowIso(),
    requestedBy: settings.currentUser,
    requestedByEmail: settings.currentUserEmail,
  };
  await db.requests.add(req);
  if (input.complaintId) {
    const c = await getComplaint(db, input.complaintId);
    const names = await describeLines(db, lines);
    await addLog(db, c.id, 'note', `Requested from Lagos store (${ref}): ${names}`, settings);
    if (isOpen(c) && c.status !== 'Awaiting Parts') {
      await setStatus(db, settings, c.id, 'Awaiting Parts', `waiting for ${ref}`);
    }
  }
  return id;
}

async function describeLines(db: ServiceDB, lines: RequestLine[], sent = false) {
  const items = await db.items.bulkGet(lines.map((l) => l.itemId));
  return lines
    .map((l, i) => `${sent ? l.sentQty ?? 0 : l.qty} ${items[i]?.unit ?? ''} ${items[i]?.name ?? 'item'}`)
    .join(', ');
}

/** Service Head approves or rejects. */
export async function decideRequest(db: ServiceDB, settings: AppSettings, id: string, approve: boolean, note?: string) {
  const r = await getRequest(db, id);
  if (r.status !== 'Requested') throw new Error(`This request is already ${r.status.toLowerCase()}`);
  if (!approve && !note?.trim()) throw new Error('Give a reason for rejecting the request');
  await db.requests.update(id, {
    status: approve ? 'Approved' : 'Rejected',
    decidedAt: nowIso(),
    decidedBy: settings.currentUser,
    decisionNote: note?.trim() || undefined,
  });
  if (r.complaintId) {
    await addLog(db, r.complaintId, 'note', `${r.ref} ${approve ? 'approved' : `rejected: ${note}`}`, settings);
  }
}

/**
 * Lagos sends the goods. `sent` gives the quantity actually sent per item
 * (defaults to what was asked). Stock leaves Lagos now.
 */
export async function dispatchRequest(
  db: ServiceDB,
  settings: AppSettings,
  id: string,
  input: { sent?: Record<string, number>; waybill?: string; carrier?: string },
) {
  const r = await getRequest(db, id);
  if (r.status !== 'Approved') throw new Error('Only approved requests can be dispatched');
  const lines = r.lines.map((l) => ({ ...l, sentQty: input.sent?.[l.itemId] ?? l.qty }));
  if (!lines.some((l) => l.sentQty > 0)) throw new Error('Nothing to send');
  const complaint = r.complaintId ? await getComplaint(db, r.complaintId) : undefined;
  await db.transaction('rw', [db.requests, db.items, db.movements, db.logs], async () => {
    for (const l of lines) {
      if (!(l.sentQty > 0)) continue;
      await recordMovement(db, {
        itemId: l.itemId,
        kind: complaint ? 'Issue' : 'Transfer',
        qty: -l.sentQty,
        complaintId: complaint?.id,
        technicianId: complaint?.technicianId,
        branch: r.branch,
        requestId: r.id,
        reference: r.ref,
        note: `Dispatched to ${r.branch}${input.waybill ? `, waybill ${input.waybill}` : ''}`,
        by: settings.currentUser,
        byEmail: settings.currentUserEmail,
      });
    }
    await db.requests.update(id, {
      lines,
      status: 'Dispatched',
      dispatchedAt: nowIso(),
      dispatchedBy: settings.currentUser,
      waybill: input.waybill?.trim() || undefined,
      carrier: input.carrier?.trim() || undefined,
    });
    if (complaint) {
      await addLog(
        db,
        complaint.id,
        'material',
        `${r.ref} dispatched to ${r.branch}: ${await describeLines(db, lines, true)}${input.waybill ? ` (waybill ${input.waybill})` : ''}`,
        settings,
      );
    }
  });
  if (complaint) await reevaluate(db, settings, complaint.id);
}

/** The branch confirms the goods arrived; the job goes back to In Progress. */
export async function receiveRequest(db: ServiceDB, settings: AppSettings, id: string, note?: string) {
  const r = await getRequest(db, id);
  if (r.status !== 'Dispatched') throw new Error('Only dispatched requests can be received');
  await db.requests.update(id, { status: 'Received', receivedAt: nowIso(), receivedBy: settings.currentUser, receivedNote: note?.trim() || undefined });
  if (r.complaintId) {
    const c = await getComplaint(db, r.complaintId);
    await addLog(db, c.id, 'note', `${r.ref} received at ${r.branch}${note ? `: ${note}` : ''}`, settings);
    // Back to work once nothing else is outstanding for this job.
    const outstanding = await db.requests
      .where('complaintId')
      .equals(c.id)
      .filter((x) => x.id !== id && ['Requested', 'Approved', 'Dispatched'].includes(x.status))
      .count();
    if (c.status === 'Awaiting Parts' && outstanding === 0) await setStatus(db, settings, c.id, 'In Progress', 'parts received');
  }
}

export async function cancelRequest(db: ServiceDB, settings: AppSettings, id: string, note: string) {
  const r = await getRequest(db, id);
  if (r.status !== 'Requested' && r.status !== 'Approved') throw new Error('Only requests not yet dispatched can be cancelled');
  await db.requests.update(id, { status: 'Cancelled', decisionNote: note, decidedAt: nowIso(), decidedBy: settings.currentUser });
  if (r.complaintId) await addLog(db, r.complaintId, 'note', `${r.ref} cancelled: ${note}`, settings);
}
