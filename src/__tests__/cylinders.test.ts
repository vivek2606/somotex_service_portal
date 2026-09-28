import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { contentAt, refillCylinder, registerCylinder, retireCylinder, weighIn, weighOut } from '../db/cylinders';
import { ServiceDB } from '../db/db';
import { createComplaint, materialUsage, updateJobDetails } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Store', currentUserEmail: 'store@x.com' };
let db: ServiceDB;
let n = 0;
const R32 = 'r32';
const N2 = 'n2';

beforeEach(async () => {
  db = new ServiceDB(`cyl-${n++}`);
  await db.items.bulkAdd([
    { id: R32, sku: 'REF-R32', name: 'R-32', type: 'Refrigerant', unit: 'kg', refrigerant: 'R32', stock: 0, reorderLevel: 1, unitCost: 0, active: true },
    { id: N2, sku: 'GAS-N2', name: 'Nitrogen', type: 'Nitrogen', unit: 'm³', stock: 0, reorderLevel: 1, unitCost: 0, active: true, norm: { perPressureTest: 0.3 } },
  ]);
});

const job = () =>
  createComplaint(db, settings, {
    customer: { name: 'C', phone: '1', address: 'x', type: 'Individual' },
    equipment: { brand: 'Midea', category: 'Residential AC', model: 'M', serialNo: 'S', capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32', warranty: 'Unknown' },
    complaintType: 'Not cooling', description: '', priority: 'Normal', source: 'Phone',
  });

describe('cylinders', () => {
  it('computes contents by weight and by pressure', () => {
    expect(contentAt({ measure: 'weight', tareKg: 7.5 }, 17.5)).toBe(10);
    expect(contentAt({ measure: 'pressure', capacityL: 50 }, 150)).toBe(7.5);
  });

  it('registers a cylinder as a receipt unless already counted', async () => {
    await registerCylinder(db, settings, { tag: 'r32-01', itemId: R32, tareKg: 7.5, reading: 17.5, alreadyInStock: false });
    expect((await db.items.get(R32))!.stock).toBe(10);
    await registerCylinder(db, settings, { tag: 'R32-02', itemId: R32, tareKg: 7.5, reading: 12.5, alreadyInStock: true });
    expect((await db.items.get(R32))!.stock).toBe(10);
    await expect(registerCylinder(db, settings, { tag: 'R32-01', itemId: R32, tareKg: 7, reading: 9, alreadyInStock: true })).rejects.toThrow(/already registered/);
  });

  it('books the weighed difference to the job and raises alerts from real use', async () => {
    const id = await job();
    await updateJobDetails(db, settings, id, { jobType: 'Gas Top-up' });
    const cyl = await registerCylinder(db, settings, { tag: 'R32-01', itemId: R32, tareKg: 7.5, reading: 17.5, alreadyInStock: false });
    await weighOut(db, settings, { cylinderId: cyl, reading: 17.5, complaintId: id });
    expect((await db.cylinders.get(cyl))!.status).toBe('Out');
    await expect(weighIn(db, settings, { cylinderId: cyl, reading: 18 })).rejects.toThrow(/higher than when it went out/);
    const res = await weighIn(db, settings, { cylinderId: cyl, reading: 16.3 });
    expect(res.used).toBe(1.2);
    expect((await db.items.get(R32))!.stock).toBe(8.8);
    expect((await materialUsage(db, id))[0]).toMatchObject({ qty: 1.2 });
    // 1.2 kg on a 12,000 BTU/h top-up is well over budget.
    expect((await db.alerts.where('complaintId').equals(id).toArray()).some((a) => a.code === 'over-consumption')).toBe(true);
    expect((await db.cylinders.get(cyl))!).toMatchObject({ status: 'In store', lastReading: 16.3 });
  });

  it('detects gas lost while the cylinder was in the store', async () => {
    const cyl = await registerCylinder(db, settings, { tag: 'R32-01', itemId: R32, tareKg: 7.5, reading: 17.5, alreadyInStock: false });
    const out = await weighOut(db, settings, { cylinderId: cyl, reading: 16.9 });
    expect(out.loss).toBe(0.6);
    const loss = await db.movements.where('kind').equals('Loss').first();
    expect(loss!.qty).toBe(-0.6);
    expect((await db.items.get(R32))!.stock).toBe(9.4);
  });

  it('refuses a weigh-out heavier than the last reading, and handles refills and retiring', async () => {
    const cyl = await registerCylinder(db, settings, { tag: 'R32-01', itemId: R32, tareKg: 7.5, reading: 9.5, alreadyInStock: false });
    await expect(weighOut(db, settings, { cylinderId: cyl, reading: 17 })).rejects.toThrow(/record the refill first/);
    expect(await refillCylinder(db, settings, cyl, 17.5)).toBe(8);
    expect((await db.items.get(R32))!.stock).toBe(10);
    await retireCylinder(db, settings, cyl, 'Valve damaged, returned to supplier');
    expect((await db.items.get(R32))!.stock).toBe(0);
    expect((await db.cylinders.get(cyl))!.status).toBe('Retired');
  });

  it('measures pressure cylinders in m³', async () => {
    const id = await job();
    const cyl = await registerCylinder(db, settings, { tag: 'N2-01', itemId: N2, capacityL: 50, reading: 150, alreadyInStock: false });
    await weighOut(db, settings, { cylinderId: cyl, reading: 150, complaintId: id });
    const res = await weighIn(db, settings, { cylinderId: cyl, reading: 140 });
    expect(res).toEqual({ used: 0.5, unit: 'm³' });
  });
});
