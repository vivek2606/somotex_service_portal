import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceDB } from '../db/db';
import {
  acknowledgeAlert,
  createComplaint,
  importStockRows,
  issueToComplaint,
  logCustomerContact,
  materialUsage,
  receiveStock,
  reevaluate,
  returnFromComplaint,
  setStatus,
  updateJobDetails,
} from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';
import { mapStockSheet, parseCsv } from '../lib/csv';
import type { NewComplaint } from '../db/service';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Test Desk' };
let db: ServiceDB;
let n = 0;
const R32 = 'item-r32';

const complaint = (over: Partial<NewComplaint> = {}): NewComplaint => ({
  customer: { name: 'A', phone: '1', address: 'x', type: 'Individual' },
  equipment: {
    brand: 'Tamashi', category: 'Residential AC', model: 'T12', serialNo: 'SN1',
    capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32', warranty: 'In Warranty',
  },
  complaintType: 'Not cooling / low cooling',
  description: 'warm air',
  customerStatement: 'It stopped cooling yesterday evening',
  priority: 'Normal',
  source: 'Phone',
  ...over,
});

beforeEach(async () => {
  db = new ServiceDB(`test-${n++}`);
  await db.items.add({ id: R32, sku: 'REF-R32', name: 'R32', type: 'Refrigerant', unit: 'kg', refrigerant: 'R32', stock: 0, reorderLevel: 5, unitCost: 0, active: true });
});

describe('complaints', () => {
  it('numbers tickets sequentially and records the customer statement', async () => {
    const a = await createComplaint(db, settings, complaint());
    const b = await createComplaint(db, settings, complaint());
    const [ca, cb] = await db.complaints.bulkGet([a, b]);
    const year = new Date().getFullYear();
    expect(ca!.ticketNo).toBe(`SMX-${year}-00001`);
    expect(cb!.ticketNo).toBe(`SMX-${year}-00002`);
    expect(ca!.loggedBy).toBe('Test Desk');
    const logs = await db.logs.where('complaintId').equals(a).toArray();
    expect(logs.some((l) => l.kind === 'customer' && l.text.includes('stopped cooling'))).toBe(true);
    await logCustomerContact(db, settings, a, 'Visit confirmed', 'Available after 2pm');
    expect(await db.logs.where('complaintId').equals(a).count()).toBe(3);
  });

  it('assigns a technician at registration', async () => {
    const techId = 'tech-1';
    await db.technicians.add({ id: techId, name: 'T1', phone: '1', skills: '', active: true });
    const id = await createComplaint(db, settings, complaint({ technicianId: techId }));
    expect((await db.complaints.get(id))!.status).toBe('Assigned');
    const logs = await db.logs.where('complaintId').equals(id).toArray();
    expect(logs.some((l) => l.kind === 'assignment' && l.text.includes('T1'))).toBe(true);
  });

  it('requires job type and resolution before closing', async () => {
    const id = await createComplaint(db, settings, complaint());
    await expect(setStatus(db, settings, id, 'Closed')).rejects.toThrow(/job type/);
    await updateJobDetails(db, settings, id, { jobType: 'PCB / Electrical Repair', resolution: 'Replaced PCB' });
    await setStatus(db, settings, id, 'Closed');
    const c = await db.complaints.get(id);
    expect(c!.status).toBe('Closed');
    expect(c!.closedAt).toBeTruthy();
    await setStatus(db, settings, id, 'In Progress');
    expect((await db.complaints.get(id))!.closedAt).toBeUndefined();
  });
});

describe('stock and alerts', () => {
  it('issues, returns and blocks over-issue', async () => {
    const id = await createComplaint(db, settings, complaint());
    await receiveStock(db, settings, R32, 5);
    await expect(issueToComplaint(db, settings, id, R32, 1.5)).rejects.toThrow(/Enter a reason/);
    await issueToComplaint(db, settings, id, R32, 1.5, 'Customer site has 12 m pipe run');
    await returnFromComplaint(db, settings, id, R32, 0.5);
    expect((await db.items.get(R32))!.stock).toBe(4);
    expect((await materialUsage(db, id))[0].qty).toBe(1);
    await expect(issueToComplaint(db, settings, id, R32, 10, 'test')).rejects.toThrow(/Not enough stock/);
    await expect(returnFromComplaint(db, settings, id, R32, 2)).rejects.toThrow();
  });

  it('raises over-consumption alerts and respects acknowledgement', async () => {
    const id = await createComplaint(db, settings, complaint());
    await updateJobDetails(db, settings, id, { jobType: 'Gas Top-up' });
    await receiveStock(db, settings, R32, 5);
    const alerts = await issueToComplaint(db, settings, id, R32, 1, 'Heavy leak');
    expect(alerts.map((a) => a.code)).toEqual(['over-consumption']);
    await acknowledgeAlert(db, settings, alerts[0].id!, 'Verified: long pipe run');
    expect(await reevaluate(db, settings, id)).toEqual([]);
    // More gas changes the figure, so it is raised again.
    expect((await issueToComplaint(db, settings, id, R32, 0.2, 'More needed')).length).toBe(1);
  });

  it('detects repeat charging of the same serial number', async () => {
    await receiveStock(db, settings, R32, 5);
    const first = await createComplaint(db, settings, complaint());
    await updateJobDetails(db, settings, first, { jobType: 'Gas Top-up' });
    await issueToComplaint(db, settings, first, R32, 0.2);
    const second = await createComplaint(db, settings, complaint());
    await updateJobDetails(db, settings, second, { jobType: 'Gas Top-up' });
    const alerts = await issueToComplaint(db, settings, second, R32, 0.2);
    expect(alerts.some((a) => a.code === 'repeat-charge')).toBe(true);
  });
});

describe('issue budget', () => {
  it('allows issuing within the job budget without a reason', async () => {
    const id = await createComplaint(db, settings, complaint());
    await updateJobDetails(db, settings, id, { jobType: 'Leak Repair + Full Recharge', pipeLengthM: 5 });
    await receiveStock(db, settings, R32, 5);
    // 12,000 BTU/h R32 ≈ 563 g + 30 g allowance = 593 g; limit +15 %.
    await issueToComplaint(db, settings, id, R32, 0.6);
    await expect(issueToComplaint(db, settings, id, R32, 0.1)).rejects.toThrow(/budget/);
  });
});

describe('stock sheet import', () => {
  it('maps flexible headers and upserts by SKU with ledger entries', async () => {
    const csv = 'Part No,Description,UOM,Qty,Min Stock\nREF-R32,Refrigerant R32,KGS,25,10\n,Oxygen cylinder gas,m3,8,\nCAP-1,Capacitor 35uF,Nos,"1,200",5\n';
    const sheet = mapStockSheet(parseCsv(csv));
    expect(sheet.errors).toEqual([]);
    expect(sheet.rows.map((r) => r.type)).toEqual(['Refrigerant', 'Brazing Gas', 'Spare']);
    const res = await importStockRows(db, settings, sheet.rows);
    expect(res).toEqual({ created: 2, updated: 1, stockSet: 3 });
    const r32 = await db.items.where('sku').equals('REF-R32').first();
    expect(r32).toMatchObject({ stock: 25, unit: 'kg', reorderLevel: 10 });
    expect((await db.items.where('sku').equals('CAP-1').first())!.stock).toBe(1200);
    expect(await db.movements.count()).toBe(3);
  });
});

describe('change tracking for sync', () => {
  it('marks local writes dirty but not remote writes or derived stock', async () => {
    const id = await createComplaint(db, settings, complaint());
    expect((await db.complaints.get(id))!._dirty).toBe(1);
    await db.complaints.update(id, { _dirty: 0 });
    expect((await db.complaints.get(id))!._dirty).toBe(0);
    await db.items.update(R32, { _dirty: 0 });
    await db.items.update(R32, { stock: 9 });
    expect((await db.items.get(R32))!._dirty).toBe(0);
    await db.applyRemote(['complaints'], async () => {
      await db.complaints.update(id, { description: 'from server' });
    });
    expect((await db.complaints.get(id))!._dirty).toBe(0);
    await db.complaints.update(id, { description: 'local edit' });
    expect((await db.complaints.get(id))!._dirty).toBe(1);
  });

  it('clears alerts that no longer apply instead of deleting them', async () => {
    const id = await createComplaint(db, settings, complaint());
    await updateJobDetails(db, settings, id, { jobType: 'Gas Top-up' });
    await receiveStock(db, settings, R32, 5);
    const [alert] = await issueToComplaint(db, settings, id, R32, 1, 'Heavy leak');
    await returnFromComplaint(db, settings, id, R32, 0.9);
    const stored = await db.alerts.get(alert.id);
    expect(stored!.cleared).toBe(true);
  });
});
