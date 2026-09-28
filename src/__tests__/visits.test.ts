import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { runtime, ServiceDB } from '../db/db';
import { createComplaint, setStatus } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';
import { isMissedVisit, reminderText, scheduleVisit } from '../db/visits';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Desk', currentUserEmail: 'desk@x.com' };
let db: ServiceDB;
let n = 0;

beforeEach(async () => {
  db = new ServiceDB(`visit-${n++}`);
  await db.technicians.add({ id: 't1', name: 'Kunle', phone: '1', skills: '', active: true });
});

const job = () =>
  createComplaint(db, settings, {
    customer: { name: 'Bisi', phone: '1', address: 'x', type: 'Individual' },
    equipment: { brand: 'Midea', category: 'Residential AC', model: 'M', serialNo: 'S', warranty: 'Unknown' },
    complaintType: 'Not cooling', description: '', priority: 'Normal', source: 'Phone',
  });

describe('visits', () => {
  it('books, assigns and reschedules with a timeline entry', async () => {
    const id = await job();
    await scheduleVisit(db, settings, id, { date: '2026-10-01', slot: 'Morning (8–12)', technicianId: 't1' });
    let c = (await db.complaints.get(id))!;
    expect(c).toMatchObject({ visitDate: '2026-10-01', visitSlot: 'Morning (8–12)', technicianId: 't1', status: 'Assigned' });
    await scheduleVisit(db, settings, id, { date: '2026-10-02', slot: 'Afternoon (12–4)', reason: 'customer travelling' });
    c = (await db.complaints.get(id))!;
    expect(c.visitDate).toBe('2026-10-02');
    const logs = await db.logs.where('complaintId').equals(id).toArray();
    expect(logs.some((l) => l.text.startsWith('Visit moved from 2026-10-01'))).toBe(true);
    expect(reminderText(c, 'Bisi', 'Kunle', 'Somotex')).toMatch(/Kunle will visit on .*Afternoon/);
  });

  it('flags a missed visit only when the slot has passed and work has not started', async () => {
    const id = await job();
    await scheduleVisit(db, settings, id, { date: '2026-10-01', slot: 'Morning (8–12)', technicianId: 't1' });
    const c = (await db.complaints.get(id))!;
    expect(isMissedVisit(c, new Date('2026-10-01T11:00:00'))).toBe(false);
    expect(isMissedVisit(c, new Date('2026-10-01T12:30:00'))).toBe(true);
    await setStatus(db, settings, id, 'In Progress');
    expect(isMissedVisit((await db.complaints.get(id))!, new Date('2026-10-01T12:30:00'))).toBe(false);
    expect(runtime.now).toBeTypeOf('function');
  });
});
