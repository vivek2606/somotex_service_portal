import { describe, expect, it } from 'vitest';
import type { Complaint, Customer } from '../db/types';
import {
  branchScorecard,
  leakHotspots,
  powerAnalysis,
  productQuality,
  repeatCustomers,
  seasonalForecast,
  technicianRanking,
  type JobFacts,
} from '../lib/insights';

let seq = 0;
function job(p: Partial<Complaint> & { eq?: Partial<Complaint['equipment']> } = {}, f: Partial<JobFacts> = {}): JobFacts {
  const { eq, ...rest } = p;
  const c: Complaint = {
    id: `c${++seq}`,
    ticketNo: `T${seq}`,
    customerId: 'cu1',
    equipment: { brand: 'Tamashi', category: 'Residential AC', model: 'TSA-12', serialNo: `TSA1225-${seq}`, warranty: 'Unknown', ...eq },
    complaintType: 'Not cooling',
    description: '',
    loggedBy: 'Desk',
    priority: 'Normal',
    status: 'Closed',
    source: 'Phone',
    createdAt: '2026-06-10T09:00:00.000Z',
    updatedAt: '2026-06-10T09:00:00.000Z',
    dueAt: '2026-06-13T09:00:00.000Z',
    closedAt: '2026-06-11T09:00:00.000Z',
    branch: 'Abuja',
    ...rest,
  };
  return { c, refrigerantG: 0, spares: [], materialCost: 0, cameBack: false, waitedForParts: false, ...f };
}

describe('gas leak hotspots', () => {
  it('counts leak points, shares gas between them and finds units that leak again', () => {
    const facts = [
      job({ jobType: 'Leak Repair + Full Recharge', leakPoints: ['Flare nut / union', 'Service valve'], eq: { serialNo: 'A1' } }, { refrigerantG: 1000 }),
      job({ jobType: 'Gas Top-up', leakPoints: ['Flare nut / union'], eq: { serialNo: 'A1' }, createdAt: '2026-07-01T00:00:00Z' }, { refrigerantG: 400 }),
      job({ jobType: 'Gas Top-up' }, { refrigerantG: 300 }),
      job({ jobType: 'PCB / Electrical Repair' }),
    ];
    const r = leakHotspots(facts);
    expect(r.leakJobs).toBe(3);
    expect(r.unrecorded).toBe(1);
    expect(r.byPoint[0]).toEqual({ point: 'Flare nut / union', jobs: 2, refrigerantKg: 0.9 });
    expect(r.byPoint[1]).toEqual({ point: 'Service valve', jobs: 1, refrigerantKg: 0.5 });
    expect(r.repeatUnits).toHaveLength(1);
    expect(r.repeatUnits[0]).toMatchObject({ serialNo: 'A1', refrigerantKg: 1.4 });
  });
});

describe('product quality', () => {
  it('groups failures by model and batch, with months from sale to first failure', () => {
    const facts = [
      job({ eq: { serialNo: 'TSA1225-001', purchaseDate: '2026-04-10' }, createdAt: '2026-06-10T00:00:00Z' }, { spares: [{ itemId: 'p', name: 'PCB', qty: 1 }] }),
      job({ eq: { serialNo: 'TSA1225-001', purchaseDate: '2026-04-10' }, createdAt: '2026-08-10T00:00:00Z' }),
      job({ eq: { serialNo: 'TSA1301-002', purchaseDate: '2025-01-10' }, createdAt: '2026-06-10T00:00:00Z' }),
      job({ eq: { brand: 'Midea', serialNo: 'MD-1' } }),
      job({ eq: { serialNo: 'TSA1225-003' }, jobType: 'New Installation' }),
    ];
    const q = productQuality(facts, new Set(['Tamashi']), 7, () => undefined);
    expect(q.failures).toBe(3);
    const m = q.byModel[0];
    expect(m).toMatchObject({ model: 'Tamashi TSA-12', failures: 3, units: 2, early: 1 });
    expect(m.parts).toEqual([{ name: 'PCB', count: 1 }]);
    expect(q.byBatch.map((b) => [b.batch, b.failures, b.early])).toEqual([
      ['TSA1225', 2, 1],
      ['TSA1301', 1, 0],
    ]);
    expect(q.byAge.find((a) => a.bucket === 'Under 3 months')!.units).toBe(1);
    expect(q.byAge.find((a) => a.bucket === '1–2 years')!.units).toBe(1);
  });
});

describe('power-related failures', () => {
  it('compares failures with and without a stabiliser and flags warranty claims to review', () => {
    const lagos = { id: 'cu1', name: 'A', phone: '1', address: 'x', city: 'Lagos', type: 'Individual', createdAt: '' } as Customer;
    const facts = [
      job({ jobType: 'PCB / Electrical Repair', stabiliser: 'No', supplyVoltage: 180, eq: { warranty: 'In Warranty' } }, { customer: lagos }),
      job({ jobType: 'Compressor Replacement', stabiliser: 'No', powerSource: 'Generator' }, { customer: lagos }),
      job({ jobType: 'Gas Top-up', stabiliser: 'No', supplyVoltage: 230 }, { customer: lagos }),
      job({ jobType: 'Gas Top-up', stabiliser: 'Yes', supplyVoltage: 225 }, { customer: lagos }),
      job({ jobType: 'PCB / Electrical Repair', stabiliser: 'Yes', supplyVoltage: 228 }),
    ];
    const p = powerAnalysis(facts);
    expect(p.electrical).toBe(3);
    expect(p.withoutStabiliser).toEqual({ jobs: 3, electrical: 2 });
    expect(p.withStabiliser).toEqual({ jobs: 2, electrical: 1 });
    const lg = p.byArea.find((a) => a.area === 'Lagos')!;
    expect(lg).toMatchObject({ electrical: 2, noStabiliser: 2, generator: 1, badVoltage: 1 });
    expect(p.warrantyReview).toHaveLength(1);
    expect(p.warrantyReview[0].reasons).toEqual(['supply measured at 180 V', 'no stabiliser']);
  });
});

describe('seasonal forecast', () => {
  const now = new Date(2026, 8, 15); // 15 Sep 2026
  it('uses last year with a trend once a year of history exists', () => {
    const out = [];
    for (let m = 0; m < 20; m++) {
      const d = new Date(2025, 1 + m, 10); // Feb 2025 → Sep 2026
      // Last year's Oct–Dec 10 kg each; everything else 5 kg; the last 3 months ran 20% higher than a year before.
      const lastYear = d.getFullYear() === 2025 && d.getMonth() >= 9;
      const recent = d.getFullYear() === 2026 && d.getMonth() >= 5 && d.getMonth() <= 7;
      out.push({ at: d.toISOString(), refrigerant: 'R32', grams: (lastYear ? 10 : recent ? 6 : 5) * 1000 });
    }
    const [f] = seasonalForecast(out, { R32: 4 }, now);
    expect(f.basis).toBe('last-year');
    expect(f.next.map((n) => n.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(f.next.map((n) => n.kg)).toEqual([12, 12, 12]);
    expect(f.orderKg).toBe(Math.ceil(36 * 1.1 - 4));
    expect(f.history).toHaveLength(13);
  });

  it('uses the recent rate and the typical season before that', () => {
    const out = [];
    for (let d = 0; d < 60; d++) out.push({ at: new Date(2026, 6, 17 + d).toISOString(), refrigerant: 'R410A', grams: 100 });
    const [f] = seasonalForecast(out, {}, now);
    expect(f.basis).toBe('seasonal-pattern');
    // About 3 kg a month in the rains (factor ~0.82); October's factor is higher.
    expect(f.next[0].kg).toBeGreaterThan(3.2);
    expect(f.next[0].kg).toBeLessThan(4);
  });
});

describe('branch scorecard', () => {
  it('reports first-time fix, come-backs, gas vs budget and cost per job', () => {
    const facts = [
      job({ branch: 'Kano', customerFeedback: 5 }, { refrigerantG: 600, refrigerantBudgetG: 500, materialCost: 10000 }),
      job({ branch: 'Kano', closedAt: '2026-06-20T09:00:00Z' }, { waitedForParts: true, materialCost: 2000 }),
      job({ branch: 'Kano' }, { cameBack: true }),
    ];
    const [kano] = branchScorecard(facts, ['Kano', 'Abuja']).filter((b) => b.branch === 'Kano');
    expect(kano).toMatchObject({ closed: 3, firstTimeFixPct: 33, cameBackPct: 33, gasVsBudgetPct: 120, rating: 5, costPerJob: 4000, withinTargetPct: 67 });
  });
});

describe('technician ranking', () => {
  it('ranks on actual against budget, only with enough jobs', () => {
    const rows = technicianRanking(
      [
        ...Array.from({ length: 3 }, () => ({ technicianId: 'big', budgetG: 3000, actualG: 3000 })),
        ...Array.from({ length: 3 }, () => ({ technicianId: 'small', budgetG: 500, actualG: 700 })),
        { technicianId: 'new', budgetG: 500, actualG: 400 },
      ],
      15,
    );
    expect(rows.map((r) => [r.technicianId, r.rank])).toEqual([
      ['big', 1],
      ['small', 2],
      ['new', undefined],
    ]);
    expect(rows[1]).toMatchObject({ overJobs: 3, excessG: 600, avgBudgetG: 500 });
  });
});

describe('repeat customers', () => {
  it('flags the same unit failing and suggests AMC for businesses', () => {
    const shop = { id: 'b1', name: 'Shop', phone: '1', address: 'x', type: 'Business', createdAt: '' } as Customer;
    const facts = [1, 2, 3].map((i) => job({ customerId: 'b1', eq: { serialNo: 'X1' }, createdAt: `2026-0${i + 3}-01T00:00:00Z` }, { customer: shop }));
    facts.push(job({ customerId: 'b1', jobType: 'Preventive Maintenance' }, { customer: shop }));
    const [r] = repeatCustomers(facts, 3);
    expect(r).toMatchObject({ complaints: 3, units: 1, open: 0 });
    expect(r.worstUnit).toMatchObject({ serialNo: 'X1', count: 3 });
    expect(r.flags).toEqual(['Same unit keeps failing: check the installation', 'AMC candidate']);
    expect(repeatCustomers(facts, 4)).toHaveLength(0);
  });
});
