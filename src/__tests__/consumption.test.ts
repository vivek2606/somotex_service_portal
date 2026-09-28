import { describe, expect, it } from 'vitest';
import {
  capacityToKw,
  DEFAULT_NORMS,
  estimateNominalCharge,
  evaluateJob,
  expectedRefrigerant,
  technicianTrends,
} from '../lib/consumption';
import type { Equipment, InventoryItem } from '../db/types';

const splitAc: Equipment = {
  brand: 'Midea',
  category: 'Residential AC',
  model: 'X',
  serialNo: 'S1',
  capacity: 18000,
  capacityUnit: 'BTU/h',
  refrigerant: 'R32',
  warranty: 'In Warranty',
};

const r32: InventoryItem = {
  id: 1, sku: 'R32', name: 'R32', type: 'Refrigerant', unit: 'kg', refrigerant: 'R32',
  stock: 10, reorderLevel: 1, unitCost: 0, active: true,
};
const r22: InventoryItem = { ...r32, id: 2, sku: 'R22', name: 'R22', refrigerant: 'R22' };
const oxygen: InventoryItem = {
  id: 3, sku: 'O2', name: 'Oxygen', type: 'Brazing Gas', unit: 'm³',
  stock: 10, reorderLevel: 1, unitCost: 0, active: true, norm: { perJob: 0.05, perJoint: 0.02 },
};

const job = (over: Partial<Parameters<typeof evaluateJob>[0]> = {}) => ({
  equipment: splitAc,
  jobType: 'Leak Repair + Full Recharge' as const,
  pipeLengthM: 5,
  brazedJoints: 2,
  createdAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('capacity and charge estimation', () => {
  it('converts capacity units to kW', () => {
    expect(capacityToKw(12000, 'BTU/h')).toBeCloseTo(3.517, 2);
    expect(capacityToKw(1, 'TR')).toBeCloseTo(3.517, 3);
    expect(capacityToKw(200, 'L')).toBeUndefined();
  });

  it('prefers nameplate charge', () => {
    expect(estimateNominalCharge({ ...splitAc, nameplateChargeG: 700 })).toEqual({ nominalG: 700, basis: 'nameplate' });
  });

  it('estimates fridge charge from volume', () => {
    const fridge: Equipment = { ...splitAc, category: 'Chest Freezer', capacity: 300, capacityUnit: 'L', refrigerant: 'R600a' };
    expect(estimateNominalCharge(fridge).nominalG).toBe(75);
  });

  it('adds extra pipe charge beyond the pre-charged length on installation', () => {
    const exp = expectedRefrigerant(splitAc, 'New Installation', 10);
    // 5 m extra × 20 g/m + 30 g hose allowance
    expect(exp.expectedG).toBe(130);
  });
});

describe('evaluateJob', () => {
  it('is quiet when consumption is within tolerance', () => {
    const exp = expectedRefrigerant(splitAc, 'Leak Repair + Full Recharge', 5).expectedG;
    const alerts = evaluateJob(job(), [{ item: r32, qty: (exp * 1.1) / 1000 }]);
    expect(alerts).toEqual([]);
  });

  it('warns and escalates as consumption rises', () => {
    const exp = expectedRefrigerant(splitAc, 'Leak Repair + Full Recharge', 5).expectedG;
    expect(evaluateJob(job(), [{ item: r32, qty: (exp * 1.25) / 1000 }])[0].severity).toBe('warning');
    expect(evaluateJob(job(), [{ item: r32, qty: (exp * 1.6) / 1000 }])[0].severity).toBe('critical');
  });

  it('flags refrigerant on a job that needs none', () => {
    const alerts = evaluateJob(job({ jobType: 'PCB / Electrical Repair' }), [{ item: r32, qty: 0.5 }]);
    expect(alerts.map((a) => a.code)).toEqual(['unexpected-use']);
  });

  it('flags the wrong refrigerant', () => {
    const alerts = evaluateJob(job(), [{ item: r22, qty: 0.5 }]);
    expect(alerts.some((a) => a.code === 'refrigerant-mismatch' && a.severity === 'critical')).toBe(true);
  });

  it('flags repeat charging on the same unit within the window', () => {
    const alerts = evaluateJob(job({ jobType: 'Gas Top-up' }), [{ item: r32, qty: 0.2 }], DEFAULT_NORMS, [
      { complaintId: 9, ticketNo: 'SMX-2026-00009', at: '2026-04-15T00:00:00Z' },
    ]);
    expect(alerts.find((a) => a.code === 'repeat-charge')?.severity).toBe('warning');
  });

  it('ignores charges outside the repeat window', () => {
    const alerts = evaluateJob(job({ jobType: 'Gas Top-up' }), [{ item: r32, qty: 0.2 }], DEFAULT_NORMS, [
      { complaintId: 9, ticketNo: 'OLD', at: '2025-01-01T00:00:00Z' },
    ]);
    expect(alerts.find((a) => a.code === 'repeat-charge')).toBeUndefined();
  });

  it('checks brazing gas against joints brazed', () => {
    // expected = 0.05 + 2 × 0.02 = 0.09 m³
    expect(evaluateJob(job(), [{ item: oxygen, qty: 0.1 }])).toEqual([]);
    expect(evaluateJob(job(), [{ item: oxygen, qty: 0.2 }])[0].severity).toBe('critical');
    expect(evaluateJob(job({ brazedJoints: 0 }), [{ item: oxygen, qty: 0.1 }])[0].code).toBe('unexpected-use');
  });
});

describe('technicianTrends', () => {
  it('flags a technician who is consistently over', () => {
    const trends = technicianTrends([
      { technicianId: 1, expectedG: 1000, actualG: 1120 },
      { technicianId: 1, expectedG: 1000, actualG: 1130 },
      { technicianId: 1, expectedG: 1000, actualG: 1300 },
      { technicianId: 2, expectedG: 1000, actualG: 1000 },
    ]);
    expect(trends[0]).toMatchObject({ technicianId: 1, jobs: 3, flagged: true });
    expect(trends[1]).toMatchObject({ technicianId: 2, flagged: false });
  });
});

describe('brazing methods', () => {
  const acetylene: InventoryItem = {
    id: 4, sku: 'C2H2', name: 'Acetylene', type: 'Brazing Gas', unit: 'kg', brazingMethod: 'Oxy-Acetylene',
    stock: 5, reorderLevel: 1, unitCost: 0, active: true, norm: { perJob: 0.03, perJoint: 0.015 },
  };
  const lpg: InventoryItem = { ...acetylene, id: 5, sku: 'LPG', name: 'LPG / Butane', brazingMethod: 'LPG / Butane', norm: { perJob: 0.03, perJoint: 0.025 } };

  it('budgets the gas of the method used', () => {
    expect(evaluateJob(job({ brazingMethod: 'LPG / Butane', brazedJoints: 4 }), [{ item: lpg, qty: 0.13 }])).toEqual([]);
  });

  it('flags gas from the other method', () => {
    const alerts = evaluateJob(job({ brazingMethod: 'LPG / Butane', brazedJoints: 4 }), [{ item: acetylene, qty: 0.1 }]);
    expect(alerts[0].code).toBe('unexpected-use');
    expect(alerts[0].message).toMatch(/Oxy-Acetylene brazing/);
  });
});

describe('nitrogen purging and MAPP', () => {
  const n2: InventoryItem = {
    id: 6, sku: 'N2', name: 'Nitrogen', type: 'Nitrogen', unit: 'm³', stock: 10, reorderLevel: 1, unitCost: 0, active: true,
    norm: { perJob: 0.05, perJoint: 0.03, perPressureTest: 0.3 },
  };
  const mapp: InventoryItem = {
    id: 7, sku: 'MAPP', name: 'MAPP', type: 'Brazing Gas', unit: 'kg', brazingMethod: 'MAPP', stock: 5, reorderLevel: 1, unitCost: 0, active: true,
    norm: { perJob: 0.02, perJoint: 0.02 },
  };

  it('budgets purge nitrogen only when purging is recorded', () => {
    // 4 joints × 0.03 + 0.05 = 0.17 m³
    expect(evaluateJob(job({ brazedJoints: 4, nitrogenPurged: true }), [{ item: n2, qty: 0.17 }])).toEqual([]);
    expect(evaluateJob(job({ brazedJoints: 4, nitrogenPurged: false }), [{ item: n2, qty: 0.17 }])[0].code).toBe('unexpected-use');
  });

  it('budgets MAPP for MAPP brazing and flags it on oxy-acetylene jobs', () => {
    expect(evaluateJob(job({ brazingMethod: 'MAPP', brazedJoints: 3 }), [{ item: mapp, qty: 0.08 }])).toEqual([]);
    expect(evaluateJob(job({ brazingMethod: 'Oxy-Acetylene', brazedJoints: 3 }), [{ item: mapp, qty: 0.08 }])[0].code).toBe('unexpected-use');
  });
});
