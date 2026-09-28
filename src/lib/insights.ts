// Management insights worked out from the complaint history: where gas leaks,
// which in-house models fail, the effect of bad power, how much refrigerant
// to hold, and how branches, technicians and customers compare.
//
// Everything here is a pure function of the facts passed in, so it can be
// tested without a database.

import type { Complaint, Customer, JobType, LeakPoint } from '../db/types';

/** One complaint with what was used on it and what happened afterwards. */
export interface JobFacts {
  c: Complaint;
  customer?: Customer;
  /** Net refrigerant used (g). */
  refrigerantG: number;
  /** Refrigerant budget (g), when the job has one. */
  refrigerantBudgetG?: number;
  /** Spare parts used (net). */
  spares: { itemId: string; name: string; qty: number }[];
  /** Cost of everything used on the job. */
  materialCost: number;
  /** The same unit was logged again within 30 days of this job being closed. */
  cameBack: boolean;
  /** The job had to wait for parts at some point. */
  waitedForParts: boolean;
}

const MONTH_MS = 30.44 * 86400000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const gToKg = (g: number) => round2(g / 1000);

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function top<T extends string>(counts: Map<T, number>, n = 3): { name: T; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

const bump = <K,>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const unitKey = (c: Complaint) => (c.equipment.serialNo?.trim() ? `${c.equipment.brand}|${c.equipment.serialNo.trim().toUpperCase()}` : undefined);
const modelName = (c: Complaint) => `${c.equipment.brand} ${c.equipment.model?.trim() || c.equipment.category}`;

// ------------------------------------------------------------- gas leaks

const LEAK_JOBS: JobType[] = ['Leak Repair + Full Recharge', 'Gas Top-up'];
export const isLeakJob = (c: Complaint) => LEAK_JOBS.includes(c.jobType as JobType) || !!c.leakPoints?.length;

export interface LeakReport {
  leakJobs: number;
  /** Leak jobs where the leak point wasn't recorded. */
  unrecorded: number;
  byPoint: { point: LeakPoint; jobs: number; refrigerantKg: number }[];
  byModel: { model: string; jobs: number; units: number; points: { name: LeakPoint; count: number }[]; refrigerantKg: number }[];
  /** Units that needed more than one leak job. */
  repeatUnits: { model: string; serialNo: string; jobs: Complaint[]; points: LeakPoint[]; refrigerantKg: number }[];
}

export function leakHotspots(facts: JobFacts[]): LeakReport {
  const leak = facts.filter((f) => isLeakJob(f.c));
  const byPoint = new Map<LeakPoint, { jobs: number; g: number }>();
  const byModel = new Map<string, { jobs: number; units: Set<string>; points: Map<LeakPoint, number>; g: number }>();
  const byUnit = new Map<string, JobFacts[]>();
  for (const f of leak) {
    const points = f.c.leakPoints ?? [];
    for (const p of points) {
      const e = byPoint.get(p) ?? { jobs: 0, g: 0 };
      e.jobs += 1;
      // Gas is shared between the points found on the job.
      e.g += f.refrigerantG / points.length;
      byPoint.set(p, e);
    }
    const m = modelName(f.c);
    const e = byModel.get(m) ?? { jobs: 0, units: new Set<string>(), points: new Map<LeakPoint, number>(), g: 0 };
    e.jobs += 1;
    e.g += f.refrigerantG;
    const u = unitKey(f.c);
    if (u) e.units.add(u);
    for (const p of points) bump(e.points, p);
    byModel.set(m, e);
    if (u) byUnit.set(u, [...(byUnit.get(u) ?? []), f]);
  }
  return {
    leakJobs: leak.length,
    unrecorded: leak.filter((f) => !f.c.leakPoints?.length).length,
    byPoint: [...byPoint.entries()]
      .map(([point, e]) => ({ point, jobs: e.jobs, refrigerantKg: gToKg(e.g) }))
      .sort((a, b) => b.jobs - a.jobs || b.refrigerantKg - a.refrigerantKg),
    byModel: [...byModel.entries()]
      .map(([model, e]) => ({ model, jobs: e.jobs, units: e.units.size, points: top(e.points), refrigerantKg: gToKg(e.g) }))
      .sort((a, b) => b.jobs - a.jobs),
    repeatUnits: [...byUnit.values()]
      .filter((list) => list.length > 1)
      .map((list) => {
        const jobs = list.map((f) => f.c).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return {
          model: modelName(jobs[0]),
          serialNo: jobs[0].equipment.serialNo,
          jobs,
          points: [...new Set(jobs.flatMap((c) => c.leakPoints ?? []))],
          refrigerantKg: gToKg(list.reduce((t, f) => t + f.refrigerantG, 0)),
        };
      })
      .sort((a, b) => b.jobs.length - a.jobs.length || b.refrigerantKg - a.refrigerantKg),
  };
}

// ------------------------------------------------------- product quality

/** Visits that are not failures of the product. */
const NOT_FAILURE: JobType[] = ['New Installation', 'Re-installation / Shifting', 'Preventive Maintenance'];
const NOT_FAILURE_TYPES = ['Installation request', 'Preventive maintenance'];
export const isFailure = (c: Complaint) =>
  c.status !== 'Cancelled' && !NOT_FAILURE.includes(c.jobType as JobType) && !NOT_FAILURE_TYPES.includes(c.complaintType);

export const AGE_BUCKETS = ['Under 3 months', '3–6 months', '6–12 months', '1–2 years', 'Over 2 years'] as const;
function ageBucket(months: number) {
  if (months < 3) return AGE_BUCKETS[0];
  if (months < 6) return AGE_BUCKETS[1];
  if (months < 12) return AGE_BUCKETS[2];
  if (months < 24) return AGE_BUCKETS[3];
  return AGE_BUCKETS[4];
}

export interface QualityReport {
  failures: number;
  byModel: {
    model: string;
    brand: string;
    failures: number;
    units: number;
    /** Median months from sale to the unit's first failure. */
    medianMonths?: number;
    /** Units that first failed within 6 months of sale. */
    early: number;
    parts: { name: string; count: number }[];
    causes: { name: string; count: number }[];
  }[];
  byPart: { name: string; count: number }[];
  byBatch: { brand: string; batch: string; failures: number; units: number; early: number; models: string[] }[];
  /** First failures by age of the unit at the time. */
  byAge: { bucket: (typeof AGE_BUCKETS)[number]; units: number }[];
  /** Units with no invoice date (age unknown). */
  unknownAge: number;
}

/**
 * Failures of the given brands by model, part and serial batch. The batch is
 * the first `batchChars` characters of the serial number.
 */
export function productQuality(
  facts: JobFacts[],
  brands: Set<string>,
  batchChars: number,
  causeName: (id: string) => string | undefined,
): QualityReport {
  const list = facts.filter((f) => brands.has(f.c.equipment.brand) && isFailure(f.c));
  // First failure of each unit, for time-to-failure.
  const first = new Map<string, Complaint>();
  for (const f of list) {
    const u = unitKey(f.c);
    if (!u) continue;
    const prev = first.get(u);
    if (!prev || f.c.createdAt < prev.createdAt) first.set(u, f.c);
  }
  const ageMonths = (c: Complaint) =>
    c.equipment.purchaseDate ? Math.max(0, (Date.parse(c.createdAt) - Date.parse(c.equipment.purchaseDate)) / MONTH_MS) : undefined;

  const models = new Map<string, { brand: string; facts: JobFacts[] }>();
  const parts = new Map<string, number>();
  const batches = new Map<string, { brand: string; batch: string; facts: JobFacts[] }>();
  for (const f of list) {
    const m = modelName(f.c);
    models.set(m, { brand: f.c.equipment.brand, facts: [...(models.get(m)?.facts ?? []), f] });
    for (const s of f.spares) bump(parts, s.name, s.qty);
    const sn = f.c.equipment.serialNo?.trim().toUpperCase();
    if (sn && batchChars > 0) {
      const batch = sn.slice(0, batchChars);
      const k = `${f.c.equipment.brand}|${batch}`;
      batches.set(k, { brand: f.c.equipment.brand, batch, facts: [...(batches.get(k)?.facts ?? []), f] });
    }
  }
  const firstOf = (fs: JobFacts[]) => {
    const units = new Set(fs.map((f) => unitKey(f.c)).filter((u): u is string => !!u));
    return [...units].map((u) => first.get(u)!).filter(Boolean);
  };
  const early = (cs: Complaint[]) => cs.filter((c) => (ageMonths(c) ?? Infinity) < 6).length;

  const byAge = new Map<(typeof AGE_BUCKETS)[number], number>();
  let unknownAge = 0;
  for (const c of first.values()) {
    const a = ageMonths(c);
    if (a === undefined) unknownAge++;
    else bump(byAge, ageBucket(a));
  }

  return {
    failures: list.length,
    byModel: [...models.entries()]
      .map(([model, { brand, facts: fs }]) => {
        const firsts = firstOf(fs);
        const p = new Map<string, number>();
        const causes = new Map<string, number>();
        for (const f of fs) {
          for (const s of f.spares) bump(p, s.name, s.qty);
          const cn = f.c.confirmedCauseId ? causeName(f.c.confirmedCauseId) : undefined;
          if (cn) bump(causes, cn);
        }
        const ages = firsts.map(ageMonths).filter((a): a is number => a !== undefined);
        const med = median(ages);
        return {
          model,
          brand,
          failures: fs.length,
          units: firsts.length,
          medianMonths: med === undefined ? undefined : round1(med),
          early: early(firsts),
          parts: top(p),
          causes: top(causes),
        };
      })
      .sort((a, b) => b.failures - a.failures || b.early - a.early),
    byPart: top(parts, 15),
    byBatch: [...batches.values()]
      .map((b) => {
        const firsts = firstOf(b.facts);
        return {
          brand: b.brand,
          batch: b.batch,
          failures: b.facts.length,
          units: firsts.length,
          early: early(firsts),
          models: [...new Set(b.facts.map((f) => f.c.equipment.model).filter(Boolean))],
        };
      })
      .sort((a, b) => b.failures - a.failures || b.early - a.early),
    byAge: AGE_BUCKETS.map((bucket) => ({ bucket, units: byAge.get(bucket) ?? 0 })),
    unknownAge,
  };
}

// ------------------------------------------------------------------ power

/** Nigeria's nominal supply is 230 V; readings outside this band are treated as bad power. */
export const VOLTAGE_BAND = { low: 200, high: 250 };

const ELECTRICAL_JOBS: JobType[] = ['PCB / Electrical Repair', 'Compressor Replacement'];
const ELECTRICAL_CAUSES = ['ac-compressor', 'ac-pcb', 'ac-capacitor', 'fr-relay', 'wm-pcb', 'tv-psu', 'tv-main', 'mw-hv'];

/** PCB, power supply and compressor failures: the ones bad power causes. */
export const isElectricalFailure = (c: Complaint) =>
  ELECTRICAL_JOBS.includes(c.jobType as JobType) || (!!c.confirmedCauseId && ELECTRICAL_CAUSES.includes(c.confirmedCauseId));

export const badVoltage = (v?: number) => v !== undefined && v > 0 && (v < VOLTAGE_BAND.low || v > VOLTAGE_BAND.high);

export interface PowerReport {
  /** Jobs with a voltage reading or stabiliser answer recorded. */
  recorded: number;
  electrical: number;
  byArea: {
    area: string;
    electrical: number;
    recorded: number;
    badVoltage: number;
    noStabiliser: number;
    generator: number;
    avgVoltage?: number;
  }[];
  /** Share of recorded jobs that were electrical failures, with and without a stabiliser. */
  withStabiliser: { jobs: number; electrical: number };
  withoutStabiliser: { jobs: number; electrical: number };
  /** In-warranty electrical failures where power conditions were outside what the warranty covers. */
  warrantyReview: { c: Complaint; reasons: string[] }[];
}

export function powerAnalysis(facts: JobFacts[]): PowerReport {
  const areaOf = (f: JobFacts) => f.customer?.city?.trim() || f.c.branch || 'Not set';
  const recordedOf = (c: Complaint) => c.supplyVoltage !== undefined || c.stabiliser !== undefined;
  const areas = new Map<string, JobFacts[]>();
  for (const f of facts) areas.set(areaOf(f), [...(areas.get(areaOf(f)) ?? []), f]);

  const withS = { jobs: 0, electrical: 0 };
  const withoutS = { jobs: 0, electrical: 0 };
  const review: PowerReport['warrantyReview'] = [];
  for (const f of facts) {
    const el = isElectricalFailure(f.c);
    if (f.c.stabiliser === 'Yes') {
      withS.jobs++;
      if (el) withS.electrical++;
    } else if (f.c.stabiliser === 'No') {
      withoutS.jobs++;
      if (el) withoutS.electrical++;
    }
    if (el && f.c.equipment.warranty === 'In Warranty') {
      const reasons: string[] = [];
      if (badVoltage(f.c.supplyVoltage)) reasons.push(`supply measured at ${f.c.supplyVoltage} V`);
      if (f.c.stabiliser === 'No') reasons.push('no stabiliser');
      if (f.c.powerSource === 'Generator') reasons.push('running on a generator');
      if (reasons.length) review.push({ c: f.c, reasons });
    }
  }

  return {
    recorded: facts.filter((f) => recordedOf(f.c)).length,
    electrical: facts.filter((f) => isElectricalFailure(f.c)).length,
    byArea: [...areas.entries()]
      .map(([area, fs]) => {
        const volts = fs.map((f) => f.c.supplyVoltage).filter((v): v is number => !!v && v > 0);
        const el = fs.filter((f) => isElectricalFailure(f.c));
        return {
          area,
          electrical: el.length,
          recorded: fs.filter((f) => recordedOf(f.c)).length,
          badVoltage: fs.filter((f) => badVoltage(f.c.supplyVoltage)).length,
          noStabiliser: el.filter((f) => f.c.stabiliser === 'No').length,
          generator: el.filter((f) => f.c.powerSource === 'Generator').length,
          avgVoltage: volts.length ? Math.round(volts.reduce((a, b) => a + b, 0) / volts.length) : undefined,
        };
      })
      .filter((a) => a.electrical > 0 || a.recorded > 0)
      .sort((a, b) => b.electrical - a.electrical),
    withStabiliser: withS,
    withoutStabiliser: withoutS,
    warrantyReview: review.sort((a, b) => b.c.createdAt.localeCompare(a.c.createdAt)),
  };
}

// ------------------------------------------------------ seasonal forecast

/**
 * Typical relative refrigerant demand by month (January first) for southern
 * Nigeria: highest in the hot months before the rains, lowest in the rainy
 * season. Used until a year of the company's own history exists.
 */
export const DEFAULT_SEASON = [1.0, 1.2, 1.35, 1.35, 1.2, 0.9, 0.8, 0.8, 0.85, 0.95, 1.0, 1.0];

export interface Outflow {
  at: string;
  /** Refrigerant name, e.g. R32. */
  refrigerant: string;
  /** Grams taken out of the store (negative for returns). */
  grams: number;
}

export interface Forecast {
  refrigerant: string;
  /** Kilograms per calendar month (YYYY-MM), oldest first, including the current month. */
  history: { month: string; kg: number }[];
  /** Next three months. */
  next: { month: string; kg: number }[];
  basis: 'last-year' | 'seasonal-pattern' | 'none';
  stockKg: number;
  /** Suggested quantity to order now to cover the next three months plus 10%. */
  orderKg: number;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const addMonth = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const daysIn = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

export function seasonalForecast(
  outflows: Outflow[],
  stockKg: Record<string, number>,
  now: Date,
  season: number[] = DEFAULT_SEASON,
  historyMonths = 13,
): Forecast[] {
  const refrigerants = [...new Set([...outflows.map((o) => o.refrigerant), ...Object.keys(stockKg)])].sort();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const factor = (d: Date) => season[d.getMonth()] || 1;
  return refrigerants.map((refrigerant) => {
    const mine = outflows.filter((o) => o.refrigerant === refrigerant);
    const byMonth = new Map<string, number>();
    for (const o of mine) bump(byMonth, monthKey(new Date(o.at)), o.grams / 1000);
    const kgIn = (d: Date) => Math.max(0, byMonth.get(monthKey(d)) ?? 0);
    const history = Array.from({ length: historyMonths }, (_, i) => addMonth(thisMonth, i - historyMonths + 1)).map((d) => ({
      month: monthKey(d),
      kg: round2(kgIn(d)),
    }));
    const firstAt = mine.length ? Math.min(...mine.map((o) => Date.parse(o.at))) : undefined;
    const next3 = [1, 2, 3].map((i) => addMonth(thisMonth, i));
    let basis: Forecast['basis'] = 'none';
    let next = next3.map((d) => ({ month: monthKey(d), kg: 0 }));

    if (firstAt !== undefined && firstAt <= addMonth(thisMonth, -12).getTime()) {
      // A year of history: same month last year, adjusted for the recent trend.
      basis = 'last-year';
      const recent = [1, 2, 3].map((i) => kgIn(addMonth(thisMonth, -i))).reduce((a, b) => a + b, 0);
      const yearBefore = [1, 2, 3].map((i) => kgIn(addMonth(thisMonth, -i - 12))).reduce((a, b) => a + b, 0);
      const trend = yearBefore > 0 ? Math.min(1.6, Math.max(0.6, recent / yearBefore)) : 1;
      next = next3.map((d) => ({ month: monthKey(d), kg: round2(kgIn(addMonth(d, -12)) * trend) }));
    } else if (firstAt !== undefined) {
      // Less than a year: recent daily rate, scaled by the typical season.
      basis = 'seasonal-pattern';
      const windowStart = Math.max(firstAt, now.getTime() - 90 * 86400000);
      const days = Math.max(14, (now.getTime() - windowStart) / 86400000);
      const used = mine.filter((o) => Date.parse(o.at) >= windowStart).reduce((t, o) => t + o.grams / 1000, 0);
      // Average season factor over the window, so a hot-season rate isn't carried into the rains.
      let fSum = 0;
      let n = 0;
      for (let t = windowStart; t <= now.getTime(); t += 86400000) {
        fSum += factor(new Date(t));
        n++;
      }
      const base = Math.max(0, used) / days / (fSum / Math.max(1, n));
      next = next3.map((d) => ({ month: monthKey(d), kg: round2(base * daysIn(d) * factor(d)) }));
    }
    const stock = round2(stockKg[refrigerant] ?? 0);
    const need = next.reduce((t, m) => t + m.kg, 0) * 1.1;
    return { refrigerant, history, next, basis, stockKg: stock, orderKg: Math.max(0, Math.ceil(need - stock)) };
  });
}

// -------------------------------------------------------- branch scorecard

export interface BranchScore {
  branch: string;
  closed: number;
  avgHours?: number;
  withinTargetPct?: number;
  /** Closed without waiting for parts and without the unit coming back within 30 days. */
  firstTimeFixPct?: number;
  cameBackPct?: number;
  /** Refrigerant used as a share of budget on jobs with a budget. */
  gasVsBudgetPct?: number;
  rating?: number;
  ratedJobs: number;
  costPerJob?: number;
}

export function branchScorecard(closedFacts: JobFacts[], branches: string[]): BranchScore[] {
  const names = [...new Set([...branches, ...closedFacts.map((f) => f.c.branch ?? 'Not set')])];
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : undefined);
  return names
    .map((branch) => {
      const fs = closedFacts.filter((f) => (f.c.branch ?? 'Not set') === branch);
      const hours = fs.map((f) => (Date.parse(f.c.resolvedAt ?? f.c.closedAt!) - Date.parse(f.c.createdAt)) / 3600000);
      const rated = fs.filter((f) => f.c.customerFeedback);
      const budgeted = fs.filter((f) => (f.refrigerantBudgetG ?? 0) > 0 && f.refrigerantG > 0);
      const budgetG = budgeted.reduce((t, f) => t + f.refrigerantBudgetG!, 0);
      const usedG = budgeted.reduce((t, f) => t + f.refrigerantG, 0);
      return {
        branch,
        closed: fs.length,
        avgHours: hours.length ? round1(hours.reduce((a, b) => a + b, 0) / hours.length) : undefined,
        withinTargetPct: pct(fs.filter((f) => (f.c.resolvedAt ?? f.c.closedAt!) <= f.c.dueAt).length, fs.length),
        firstTimeFixPct: pct(fs.filter((f) => !f.waitedForParts && !f.cameBack).length, fs.length),
        cameBackPct: pct(fs.filter((f) => f.cameBack).length, fs.length),
        gasVsBudgetPct: budgetG ? Math.round((usedG / budgetG) * 100) : undefined,
        rating: rated.length ? round1(rated.reduce((t, f) => t + f.c.customerFeedback!, 0) / rated.length) : undefined,
        ratedJobs: rated.length,
        costPerJob: fs.length ? Math.round(fs.reduce((t, f) => t + f.materialCost, 0) / fs.length) : undefined,
      };
    })
    .filter((b) => b.closed > 0 || branches.includes(b.branch));
}

// ------------------------------------------------------ technician ranking

export interface TechnicianRank {
  technicianId: string;
  jobs: number;
  /** Actual refrigerant as a share of budget: the budget already allows for unit size, job type and pipe length. */
  ratio: number;
  /** Average budget per job (g): shows the size of the work they get. */
  avgBudgetG: number;
  overJobs: number;
  excessG: number;
  /** Rank among technicians with enough jobs (1 = most efficient); undefined when too few jobs. */
  rank?: number;
}

export function technicianRanking(
  jobs: { technicianId?: string; budgetG: number; actualG: number }[],
  tolerancePct: number,
  minJobs = 3,
): TechnicianRank[] {
  const map = new Map<string, { jobs: number; budget: number; actual: number; over: number; excess: number }>();
  for (const j of jobs) {
    if (!j.technicianId || j.budgetG <= 0 || j.actualG <= 0) continue;
    const t = map.get(j.technicianId) ?? { jobs: 0, budget: 0, actual: 0, over: 0, excess: 0 };
    t.jobs++;
    t.budget += j.budgetG;
    t.actual += j.actualG;
    if (j.actualG > j.budgetG * (1 + tolerancePct / 100)) t.over++;
    t.excess += Math.max(0, j.actualG - j.budgetG);
    map.set(j.technicianId, t);
  }
  const rows: TechnicianRank[] = [...map.entries()].map(([technicianId, t]) => ({
    technicianId,
    jobs: t.jobs,
    ratio: t.actual / t.budget,
    avgBudgetG: Math.round(t.budget / t.jobs),
    overJobs: t.over,
    excessG: Math.round(t.excess),
  }));
  const ranked = rows.filter((r) => r.jobs >= minJobs).sort((a, b) => a.ratio - b.ratio);
  ranked.forEach((r, i) => (r.rank = i + 1));
  return [...ranked, ...rows.filter((r) => r.jobs < minJobs).sort((a, b) => a.ratio - b.ratio)];
}

// ---------------------------------------------------- repeat customers

export interface RepeatCustomer {
  customer: Customer;
  complaints: number;
  units: number;
  open: number;
  lastAt: string;
  topIssue: string;
  /** The unit with the most complaints, and how many. */
  worstUnit?: { model: string; serialNo: string; count: number };
  flags: string[];
}

export function repeatCustomers(facts: JobFacts[], minComplaints: number): RepeatCustomer[] {
  const byCustomer = new Map<string, JobFacts[]>();
  for (const f of facts) {
    if (!f.customer || f.c.status === 'Cancelled') continue;
    byCustomer.set(f.customer.id, [...(byCustomer.get(f.customer.id) ?? []), f]);
  }
  const out: RepeatCustomer[] = [];
  for (const fs of byCustomer.values()) {
    const failures = fs.filter((f) => isFailure(f.c));
    if (failures.length < minComplaints) continue;
    const customer = fs[0].customer!;
    const units = new Map<string, Complaint[]>();
    for (const f of failures) {
      const k = unitKey(f.c) ?? `${modelName(f.c)}|?`;
      units.set(k, [...(units.get(k) ?? []), f.c]);
    }
    const worst = [...units.values()].sort((a, b) => b.length - a.length)[0];
    const issues = new Map<string, number>();
    for (const f of failures) bump(issues, f.c.complaintType);
    const flags: string[] = [];
    if (worst && worst.length >= 3) flags.push('Same unit keeps failing: check the installation');
    const installs = fs.filter((f) => f.c.jobType === 'New Installation' || f.c.jobType === 'Re-installation / Shifting');
    if (installs.some((i) => failures.some((f) => f.c.createdAt > i.c.createdAt && Date.parse(f.c.createdAt) - Date.parse(i.c.createdAt) < 90 * 86400000))) {
      flags.push('Failed within 90 days of installation');
    }
    if (customer.type !== 'Individual' || units.size >= 2) flags.push('AMC candidate');
    out.push({
      customer,
      complaints: failures.length,
      units: units.size,
      open: failures.filter((f) => ['Registered', 'Assigned', 'In Progress', 'Awaiting Parts'].includes(f.c.status)).length,
      lastAt: failures.map((f) => f.c.createdAt).sort().pop()!,
      topIssue: top(issues, 1)[0]?.name ?? '',
      worstUnit: worst && worst.length > 1 ? { model: modelName(worst[0]), serialNo: worst[0].equipment.serialNo, count: worst.length } : undefined,
      flags,
    });
  }
  return out.sort((a, b) => b.complaints - a.complaints || b.lastAt.localeCompare(a.lastAt));
}
