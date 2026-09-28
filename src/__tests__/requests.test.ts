import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceDB } from '../db/db';
import { cancelRequest, createRequest, decideRequest, dispatchRequest, receiveRequest } from '../db/requests';
import { assignTechnician, createComplaint, materialUsage, receiveStock, setStatus } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Desk', currentUserEmail: 'desk@x.com' };
let db: ServiceDB;
let n = 0;
const CAP = 'cap';

beforeEach(async () => {
  db = new ServiceDB(`req-${n++}`);
  await db.items.add({ id: CAP, sku: 'SP-CAP', name: 'Capacitor', type: 'Spare', unit: 'pcs', stock: 0, reorderLevel: 1, unitCost: 0, active: true });
  await db.technicians.add({ id: 't1', name: 'Ibrahim', phone: '1', skills: '', active: true, branch: 'Abuja' });
  await receiveStock(db, settings, CAP, 5);
});

const job = async () => {
  const id = await createComplaint(db, settings, {
    customer: { name: 'C', phone: '1', address: 'x', type: 'Individual' },
    equipment: { brand: 'Midea', category: 'Residential AC', model: 'M', serialNo: 'S', warranty: 'Unknown' },
    complaintType: 'Not cooling', description: '', priority: 'Normal', source: 'Phone', branch: 'Abuja',
  });
  await assignTechnician(db, settings, id, 't1');
  await setStatus(db, settings, id, 'In Progress');
  return id;
};

describe('branch requests', () => {
  it('runs request → approve → dispatch → receive for a job', async () => {
    const id = await job();
    const reqId = await createRequest(db, settings, { branch: 'Abuja', complaintId: id, lines: [{ itemId: CAP, qty: 2 }] });
    expect((await db.complaints.get(id))!.status).toBe('Awaiting Parts');
    await expect(dispatchRequest(db, settings, reqId, {})).rejects.toThrow(/approved/);
    await decideRequest(db, settings, reqId, true);
    await dispatchRequest(db, settings, reqId, { sent: { [CAP]: 1 }, waybill: 'GIG-123' });
    expect((await db.items.get(CAP))!.stock).toBe(4);
    const usage = await materialUsage(db, id);
    expect(usage[0]).toMatchObject({ qty: 1 });
    const mv = await db.movements.where('requestId').equals(reqId).toArray().catch(() => db.movements.filter((m) => m.requestId === reqId).toArray());
    expect(mv[0]).toMatchObject({ branch: 'Abuja', kind: 'Issue', technicianId: 't1' });
    await receiveRequest(db, settings, reqId, 'Arrived intact');
    expect((await db.requests.get(reqId))!.status).toBe('Received');
    expect((await db.complaints.get(id))!.status).toBe('In Progress');
  });

  it('transfers stock without a job and blocks over-dispatch', async () => {
    const reqId = await createRequest(db, settings, { branch: 'Kano', lines: [{ itemId: CAP, qty: 9 }] });
    await decideRequest(db, settings, reqId, true);
    await expect(dispatchRequest(db, settings, reqId, {})).rejects.toThrow(/Not enough stock/);
    await dispatchRequest(db, settings, reqId, { sent: { [CAP]: 5 } });
    const mv = (await db.movements.toArray()).find((m) => m.requestId === reqId)!;
    expect(mv).toMatchObject({ kind: 'Transfer', qty: -5, branch: 'Kano' });
  });

  it('needs a reason to reject, and cancels only before dispatch', async () => {
    const reqId = await createRequest(db, settings, { branch: 'Kano', lines: [{ itemId: CAP, qty: 1 }] });
    await expect(decideRequest(db, settings, reqId, false)).rejects.toThrow(/reason/);
    await cancelRequest(db, settings, reqId, 'Found locally');
    expect((await db.requests.get(reqId))!.status).toBe('Cancelled');
    await expect(createRequest(db, settings, { branch: 'Kano', lines: [] })).rejects.toThrow(/at least one item/);
  });
});
