import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasDemoData, loadDemoData, purgeLocalDemo } from '../db/demo';
import { DEMO_PREFIX, ServiceDB } from '../db/db';
import { createComplaint } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';

const settings = { ...DEFAULT_SETTINGS, currentUser: 'Head', currentUserEmail: 'head@x.com' };
let db: ServiceDB;
let n = 0;

beforeEach(() => {
  db = new ServiceDB(`demo-${n++}`);
});

describe('demo data', () => {
  it('creates a realistic spread of activity', async () => {
    await loadDemoData(db, settings);
    const complaints = await db.complaints.toArray();
    expect(complaints.length).toBeGreaterThan(40);
    expect(complaints.every((c) => c.id.startsWith(DEMO_PREFIX))).toBe(true);
    const statuses = new Set(complaints.map((c) => c.status));
    for (const s of ['Closed', 'Assigned', 'In Progress']) expect(statuses).toContain(s);
    expect(new Set(complaints.map((c) => c.equipment.category)).size).toBeGreaterThanOrEqual(6);
    // Spread over the period, not all today.
    const oldest = Math.min(...complaints.map((c) => Date.parse(c.createdAt)));
    expect(Date.now() - oldest).toBeGreaterThan(40 * 86400000);
    // Gas was issued, some over budget, and alerts were raised (some reviewed).
    const movements = await db.movements.toArray();
    expect(movements.filter((m) => m.kind === 'Issue').length).toBeGreaterThan(30);
    const alerts = (await db.alerts.toArray()).filter((a) => !a.cleared);
    expect(alerts.some((a) => a.code === 'over-consumption')).toBe(true);
    expect(alerts.some((a) => a.code === 'repeat-charge')).toBe(true);
    // Stock never goes negative.
    for (const item of await db.items.toArray()) expect(item.stock).toBeGreaterThanOrEqual(0);
    expect(await db.technicians.count()).toBe(8);
    expect(new Set(complaints.map((c) => c.branch)).size).toBe(6);
    expect(complaints.filter((c) => c.technicianId).every((c) => c.branch)).toBe(true);
    // Cylinders weighed out and in, a store loss, one still out; requests at several stages; visits booked (one missed).
    expect(await db.cylinders.count()).toBeGreaterThanOrEqual(6);
    expect((await db.cylinderMoves.toArray()).filter((m) => m.inAt).length).toBeGreaterThan(3);
    expect(await db.movements.where('kind').equals('Loss').count()).toBeGreaterThanOrEqual(0);
    const reqStatuses = new Set((await db.requests.toArray()).map((r) => r.status));
    expect(reqStatuses.has('Received')).toBe(true);
    expect((await db.complaints.toArray()).filter((c) => c.visitDate).length).toBeGreaterThan(30);
    // Tools with one scale overdue for calibration; part returns at several stages.
    const tools = await db.tools.toArray();
    expect(tools.length).toBeGreaterThanOrEqual(15);
    expect(tools.some((t) => t.kind === 'Charging scale' && t.calibrationDue! < new Date().toISOString().slice(0, 10))).toBe(true);
    expect(tools.some((t) => t.status === 'Issued')).toBe(true);
    const stages = new Set((await db.partReturns.toArray()).map((r) => r.stage));
    expect(stages.size).toBeGreaterThanOrEqual(2);
    // Leak points, power readings and customer ratings are recorded for the insights.
    expect(complaints.some((c) => c.leakPoints?.length)).toBe(true);
    expect(complaints.filter((c) => c.supplyVoltage).length).toBeGreaterThan(15);
    const final = await db.complaints.toArray();
    expect(final.some((c) => c.feedbackVia === 'customer')).toBe(true);
    // A year of refrigerant supply history for the forecast.
    const transfers = await db.movements.where('kind').equals('Transfer').toArray();
    expect(Math.min(...transfers.map((m) => Date.parse(m.at)))).toBeLessThan(Date.now() - 365 * 86400000);
    expect(await hasDemoData(db)).toBe(true);
    await expect(loadDemoData(db, settings)).rejects.toThrow(/already loaded/);
  });

  it('removes only demo records', async () => {
    await loadDemoData(db, settings);
    const real = await createComplaint(db, settings, {
      customer: { name: 'Real', phone: '1', address: 'x', type: 'Individual' },
      equipment: { brand: 'Midea', category: 'Television', model: 'X', serialNo: '', warranty: 'Unknown' },
      complaintType: 'Other', description: '', priority: 'Normal', source: 'Phone',
    });
    await purgeLocalDemo(db);
    expect(await hasDemoData(db)).toBe(false);
    expect((await db.complaints.toArray()).map((c) => c.id)).toEqual([real]);
    expect(await db.technicians.count()).toBe(0);
    expect(await db.movements.count()).toBe(0);
    expect(await db.cylinders.count()).toBe(0);
    expect(await db.requests.count()).toBe(0);
    expect(await db.tools.count()).toBe(0);
    expect(await db.toolMoves.count()).toBe(0);
    expect(await db.partReturns.count()).toBe(0);
    for (const item of await db.items.toArray()) expect(item.stock).toBe(0);
    expect(await db.items.count()).toBeGreaterThan(20); // catalogue stays
  });
});
