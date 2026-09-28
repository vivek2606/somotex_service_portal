import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { runtime, ServiceDB } from '../db/db';
import { escalationMessage, markEscalated, pendingEscalations } from '../db/escalation';
import { advanceReturn, createReturn, isReturnLate } from '../db/returns';
import { createComplaint, ensurePublicToken, updateJobDetails } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';
import { addMonths, calibrateTool, calibrationState, issueTool, registerTool, returnTool, sendToolForRepair, toolRepaired } from '../db/tools';
import { publicRoute } from '../lib/links';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Desk', currentUserEmail: 'desk@x.com' };
let db: ServiceDB;
let n = 0;

beforeEach(async () => {
  db = new ServiceDB(`tools-${n++}`);
  await db.technicians.add({ id: 't1', name: 'Chidi', phone: '1', skills: '', active: true, branch: 'Port Harcourt' });
});

const complaint = (p: Partial<Parameters<typeof createComplaint>[2]> = {}) =>
  createComplaint(db, settings, {
    customer: { name: 'C', phone: '1', address: 'x', type: 'Individual' },
    equipment: { brand: 'Midea', category: 'Residential AC', model: 'M', serialNo: 'S', warranty: 'In Warranty' },
    complaintType: 'Not cooling',
    description: '',
    priority: 'Normal',
    source: 'Phone',
    branch: 'Port Harcourt',
    ...p,
  });

describe('tools', () => {
  it('tracks issue, return, repair and calibration', async () => {
    const id = await registerTool(db, settings, { tag: 'sc-01', kind: 'Charging scale', branch: 'Lagos (Head Office)', calibrationMonths: 12, lastCalibratedAt: '2026-01-15' });
    const t = (await db.tools.get(id))!;
    expect(t).toMatchObject({ tag: 'SC-01', status: 'In store', calibrationDue: '2027-01-15' });
    await expect(registerTool(db, settings, { tag: 'SC-01', kind: 'Charging scale', branch: 'Kano' })).rejects.toThrow(/already registered/);

    await issueTool(db, settings, id, 't1');
    expect((await db.tools.get(id))!).toMatchObject({ status: 'Issued', technicianId: 't1' });
    await expect(issueTool(db, settings, id, 't1')).rejects.toThrow(/already issued/);
    await returnTool(db, settings, id);
    await expect(sendToolForRepair(db, settings, id, ' ')).rejects.toThrow(/fault/);
    await sendToolForRepair(db, settings, id, 'Display dead');
    await toolRepaired(db, settings, id);
    const moves = await db.toolMoves.where('toolId').equals(id).sortBy('at');
    expect(moves.map((m) => m.kind)).toEqual(['Registered', 'Issued', 'Returned', 'Sent for repair', 'Repaired']);
    expect(moves[1]).toMatchObject({ technicianId: 't1', byEmail: 'desk@x.com' });
  });

  it('needs a reason to issue a tool that is overdue for calibration', async () => {
    const id = await registerTool(db, settings, { tag: 'MG-1', kind: 'Manifold gauge set', branch: 'Kano', calibrationMonths: 12, lastCalibratedAt: '2024-01-01' });
    expect(calibrationState((await db.tools.get(id))!)).toBe('overdue');
    await expect(issueTool(db, settings, id, 't1')).rejects.toThrow(/overdue for calibration/);
    await calibrateTool(db, settings, id, new Date().toISOString().slice(0, 10));
    expect(calibrationState((await db.tools.get(id))!)).toBe('ok');
    await issueTool(db, settings, id, 't1');
  });

  it('adds months across year ends', () => {
    expect(addMonths('2026-11-30', 3)).toBe('2027-03-02');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
  });
});

describe('defective part returns', () => {
  it('follows the part from site to the principal', async () => {
    const cid = await complaint();
    const id = await createReturn(db, settings, { complaintId: cid, partName: 'Outdoor PCB', partSerial: 'PCB-9', stage: 'With technician' });
    const r = (await db.partReturns.get(id))!;
    expect(r).toMatchObject({ brand: 'Midea', branch: 'Port Harcourt', stage: 'With technician' });
    await expect(advanceReturn(db, settings, id, 'Sent to principal')).rejects.toThrow(/Can’t move/);
    await advanceReturn(db, settings, id, 'In transit to Lagos', { waybill: 'GIGL-1', carrier: 'GIG Logistics' });
    await advanceReturn(db, settings, id, 'Received in Lagos');
    await expect(advanceReturn(db, settings, id, 'Sent to principal')).rejects.toThrow(/claim/);
    await advanceReturn(db, settings, id, 'Sent to principal', { claimRef: 'MD-RMA-77' });
    const done = (await db.partReturns.get(id))!;
    expect(done.history.map((h) => h.stage)).toEqual(['With technician', 'In transit to Lagos', 'Received in Lagos', 'Sent to principal']);
    expect(done).toMatchObject({ waybill: 'GIGL-1', claimRef: 'MD-RMA-77' });
    const logs = await db.logs.where('complaintId').equals(cid).toArray();
    expect(logs.some((l) => l.text.includes('MD-RMA-77'))).toBe(true);
  });

  it('is late when not in Lagos after two weeks', () => {
    const old = { stage: 'At branch' as const, createdAt: new Date(Date.now() - 20 * 86400000).toISOString() };
    expect(isReturnLate(old)).toBe(true);
    expect(isReturnLate({ ...old, stage: 'Received in Lagos' })).toBe(false);
  });
});

describe('escalation', () => {
  it('lists overdue and urgent jobs once, then records the escalation', async () => {
    const prev = runtime.now;
    runtime.now = () => new Date(Date.now() - 10 * 86400000);
    const late = await complaint();
    runtime.now = prev;
    const urgent = await complaint({ priority: 'Critical' });
    await complaint();
    const all = await db.complaints.toArray();
    const s = { ...settings, escalation: { ...settings.escalation, priorities: ['Critical' as const] } };
    const pending = pendingEscalations(all, s);
    expect(pending.map((e) => [e.c.id, e.reason])).toEqual(
      expect.arrayContaining([
        [late, 'overdue'],
        [urgent, 'urgent'],
      ]),
    );
    expect(pending).toHaveLength(2);
    const text = escalationMessage(pending, new Map(), new Map(), 'Somotex', (c) => `link/${c.id}`);
    expect(text).toMatch(/2 complaints need attention/);
    expect(text).toMatch(/CRITICAL priority/);
    expect(text).toMatch(/OVERDUE by \d+ h/);
    await markEscalated(db, settings, pending, 'WhatsApp');
    expect(pendingEscalations(await db.complaints.toArray(), s)).toHaveLength(0);
    // Not escalated again while it waits longer.
    expect(pendingEscalations(await db.complaints.toArray(), { escalation: { ...s.escalation, overdueHours: 0 } })).toHaveLength(0);
  });
});

describe('customer links and ratings', () => {
  it('gives each complaint an unguessable token', async () => {
    const id = await complaint();
    const token = (await db.complaints.get(id))!.publicToken!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    await db.complaints.update(id, { publicToken: undefined });
    const fresh = await ensurePublicToken(db, id);
    expect(fresh).not.toBe(token);
    expect(await ensurePublicToken(db, id)).toBe(fresh);
    expect(publicRoute(`#/track/${fresh}`)).toEqual({ kind: 'track', token: fresh });
    expect(publicRoute('#/feedback/zz')).toBeUndefined();
    expect(publicRoute('#/complaints/abc')).toBeUndefined();
  });

  it('keeps a rating the customer gave through their link', async () => {
    const id = await complaint();
    await updateJobDetails(db, settings, id, { customerFeedback: 3 });
    expect((await db.complaints.get(id))!).toMatchObject({ customerFeedback: 3, feedbackVia: 'helpdesk' });
    await db.complaints.update(id, { customerFeedback: 5, feedbackVia: 'customer', feedbackComment: 'Great' });
    await updateJobDetails(db, settings, id, { customerFeedback: 1, resolution: 'Fixed' });
    expect((await db.complaints.get(id))!).toMatchObject({ customerFeedback: 5, feedbackVia: 'customer', feedbackComment: 'Great', resolution: 'Fixed' });
  });
});
