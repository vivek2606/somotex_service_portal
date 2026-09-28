// Consumption intelligence: estimates how much refrigerant / brazing gas /
// nitrogen a job should need, and flags jobs that used materially more.
//
// All functions here are pure so they can be unit tested and reused by the
// UI (live preview) and the data layer (persisted alerts).

import type {
  AlertSeverity,
  CapacityUnit,
  Complaint,
  Equipment,
  InventoryItem,
  JobType,
  ProductCategory,
  Refrigerant,
} from '../db/types';

export interface RefrigerantNorm {
  /** Typical system charge per kW of cooling capacity (air conditioners). */
  gPerKw: number;
  /** Typical charge per litre of cabinet volume (refrigerators / freezers). */
  gPerLitre: number;
  /** Additional charge per metre of interconnecting pipe beyond the pre-charged length. */
  pipeGPerM: number;
}

export interface JobFactor {
  /** Fraction of the nominal system charge that this job normally needs. */
  chargeFraction: number;
  /** Whether additional pipe-length charge applies to this job. */
  pipeCharge: boolean;
}

export interface ConsumptionNorms {
  /** Usage above expected × (1 + tolerance) raises a warning. */
  tolerancePct: number;
  /** Usage above expected × (1 + critical) raises a critical alert. */
  criticalPct: number;
  /** Small fixed allowance (grams) for purging / hose losses per refrigerant job. */
  hoseLossG: number;
  /** Pipe length already covered by the outdoor unit's factory charge. */
  prechargedPipeM: number;
  /** Days within which another refrigerant charge on the same unit is suspicious. */
  repeatWindowDays: number;
  refrigerants: Record<Exclude<Refrigerant, 'None'>, RefrigerantNorm>;
  jobs: Record<JobType, JobFactor>;
}

export const DEFAULT_NORMS: ConsumptionNorms = {
  tolerancePct: 15,
  criticalPct: 40,
  hoseLossG: 30,
  prechargedPipeM: 5,
  repeatWindowDays: 90,
  refrigerants: {
    // ~0.55 kg per TR for R32 splits, ~0.8 kg per TR for R410A / R22.
    R32: { gPerKw: 160, gPerLitre: 0.5, pipeGPerM: 20 },
    R410A: { gPerKw: 230, gPerLitre: 0.6, pipeGPerM: 25 },
    R22: { gPerKw: 240, gPerLitre: 0.6, pipeGPerM: 30 },
    R407C: { gPerKw: 240, gPerLitre: 0.6, pipeGPerM: 30 },
    R134a: { gPerKw: 250, gPerLitre: 0.55, pipeGPerM: 30 },
    R600a: { gPerKw: 90, gPerLitre: 0.25, pipeGPerM: 10 },
    R290: { gPerKw: 90, gPerLitre: 0.25, pipeGPerM: 10 },
  },
  jobs: {
    'Inspection / Diagnosis': { chargeFraction: 0, pipeCharge: false },
    'New Installation': { chargeFraction: 0, pipeCharge: true },
    'Re-installation / Shifting': { chargeFraction: 0.25, pipeCharge: true },
    'Gas Top-up': { chargeFraction: 0.35, pipeCharge: false },
    'Leak Repair + Full Recharge': { chargeFraction: 1, pipeCharge: true },
    'Compressor Replacement': { chargeFraction: 1, pipeCharge: true },
    'Coil / Pipe Replacement': { chargeFraction: 1, pipeCharge: true },
    'PCB / Electrical Repair': { chargeFraction: 0, pipeCharge: false },
    'Mechanical Repair': { chargeFraction: 0, pipeCharge: false },
    'Preventive Maintenance': { chargeFraction: 0.1, pipeCharge: false },
    Other: { chargeFraction: 0.5, pipeCharge: false },
  },
};

export const JOB_TYPES = Object.keys(DEFAULT_NORMS.jobs) as JobType[];

const FRIDGE_CATEGORIES: ProductCategory[] = ['Refrigerator', 'Chest Freezer'];
const AC_CATEGORIES: ProductCategory[] = ['Residential AC', 'Commercial AC', 'VRF / VRV', 'Chiller'];

export function usesRefrigerant(category: ProductCategory): boolean {
  return FRIDGE_CATEGORIES.includes(category) || AC_CATEGORIES.includes(category);
}

/** Converts a cooling capacity to kW. Returns undefined for volume (litres). */
export function capacityToKw(capacity: number | undefined, unit: CapacityUnit | undefined): number | undefined {
  if (!capacity || capacity <= 0 || !unit) return undefined;
  switch (unit) {
    case 'kW':
      return capacity;
    case 'BTU/h':
      return capacity / 3412.14;
    case 'TR':
      return capacity * 3.517;
    case 'HP':
      // Trade convention for split ACs: 1 HP ≈ 9,000 BTU/h.
      return (capacity * 9000) / 3412.14;
    case 'L':
      return undefined;
  }
}

export interface ChargeEstimate {
  /** Nominal full system charge in grams. */
  nominalG: number;
  /** How the nominal charge was obtained. */
  basis: 'nameplate' | 'capacity' | 'volume' | 'unknown';
}

export function estimateNominalCharge(eq: Equipment, norms: ConsumptionNorms = DEFAULT_NORMS): ChargeEstimate {
  if (eq.nameplateChargeG && eq.nameplateChargeG > 0) {
    return { nominalG: eq.nameplateChargeG, basis: 'nameplate' };
  }
  const ref = eq.refrigerant && eq.refrigerant !== 'None' ? norms.refrigerants[eq.refrigerant] : undefined;
  if (!ref) return { nominalG: 0, basis: 'unknown' };
  if (eq.capacityUnit === 'L' && eq.capacity) {
    return { nominalG: Math.round(ref.gPerLitre * eq.capacity), basis: 'volume' };
  }
  const kw = capacityToKw(eq.capacity, eq.capacityUnit);
  if (kw) return { nominalG: Math.round(ref.gPerKw * kw), basis: 'capacity' };
  return { nominalG: 0, basis: 'unknown' };
}

export interface RefrigerantExpectation {
  expectedG: number;
  nominalG: number;
  basis: ChargeEstimate['basis'];
  breakdown: string[];
}

export function expectedRefrigerant(
  eq: Equipment,
  jobType: JobType | undefined,
  pipeLengthM: number | undefined,
  norms: ConsumptionNorms = DEFAULT_NORMS,
): RefrigerantExpectation {
  const est = estimateNominalCharge(eq, norms);
  const breakdown: string[] = [];
  const job = norms.jobs[jobType ?? 'Other'] ?? norms.jobs.Other;
  let expected = 0;

  if (job.chargeFraction > 0 && est.nominalG > 0) {
    const part = est.nominalG * job.chargeFraction;
    expected += part;
    breakdown.push(
      `${Math.round(job.chargeFraction * 100)}% of ${est.nominalG} g nominal charge (${est.basis}) = ${Math.round(part)} g`,
    );
  }

  const ref = eq.refrigerant && eq.refrigerant !== 'None' ? norms.refrigerants[eq.refrigerant] : undefined;
  const isFridge = FRIDGE_CATEGORIES.includes(eq.category);
  if (job.pipeCharge && ref && !isFridge && pipeLengthM && pipeLengthM > norms.prechargedPipeM) {
    const extraM = pipeLengthM - norms.prechargedPipeM;
    const part = extraM * ref.pipeGPerM;
    expected += part;
    breakdown.push(`${extraM.toFixed(1)} m extra pipe × ${ref.pipeGPerM} g/m = ${Math.round(part)} g`);
  }

  if (expected > 0) {
    expected += norms.hoseLossG;
    breakdown.push(`hose / purge allowance = ${norms.hoseLossG} g`);
  }

  return { expectedG: Math.round(expected), nominalG: est.nominalG, basis: est.basis, breakdown };
}

/** The job facts that drive gas and consumable budgets. */
export type JobFacts = Pick<
  Complaint,
  'equipment' | 'jobType' | 'pipeLengthM' | 'brazedJoints' | 'brazingMethod' | 'nitrogenPurged' | 'flushedPipeM' | 'pressureTested'
>;

export interface ConsumableExpectation {
  expected: number;
  breakdown: string[];
  /** Name of the activity the item is budgeted for, for messages. */
  activity: string;
}

/**
 * Expected usage of a gas or consumable that carries its own norm, in the
 * item's unit. Activity terms (brazing, flushing, pressure testing) only count
 * when that activity was recorded on the job; the per-job allowance is added
 * on top of them, so an item used without its activity is flagged.
 */
export function expectedConsumable(item: InventoryItem, job: JobFacts): ConsumableExpectation | undefined {
  const n = item.norm;
  if (!n) return undefined;
  const hasActivityNorm = !!(n.perJoint || n.perFlushM || n.perPressureTest || n.perPressureTestKw);
  if (!hasActivityNorm && !n.perJob) return undefined;
  const u = item.unit;
  if (item.brazingMethod && job.brazingMethod && item.brazingMethod !== job.brazingMethod) {
    // e.g. acetylene issued to a job brazed with LPG / butane.
    return { expected: 0, breakdown: [], activity: `${item.brazingMethod} brazing (job used ${job.brazingMethod})` };
  }
  const breakdown: string[] = [];
  const activities: string[] = [];
  const isNitrogen = item.type === 'Nitrogen';
  if (n.perJoint) activities.push(isNitrogen ? 'nitrogen purging' : 'brazed joints');
  if (n.perFlushM) activities.push('circuit flushing');
  if (n.perPressureTest || n.perPressureTestKw) activities.push('a pressure test');
  let activity = 0;

  const joints = job.brazedJoints ?? 0;
  if (n.perJoint && joints > 0 && (!isNitrogen || job.nitrogenPurged)) {
    activity += n.perJoint * joints;
    breakdown.push(`${joints} joints × ${n.perJoint} ${u}${isNitrogen ? ' purge' : ''}`);
  }
  const flushM = job.flushedPipeM ?? 0;
  if (n.perFlushM && flushM > 0) {
    activity += n.perFlushM * flushM;
    breakdown.push(`${flushM} m flushed × ${n.perFlushM} ${u}/m`);
  }
  if ((n.perPressureTest || n.perPressureTestKw) && job.pressureTested) {
    const kw = capacityToKw(job.equipment.capacity, job.equipment.capacityUnit) ?? 0;
    const pt = (n.perPressureTest ?? 0) + (n.perPressureTestKw ?? 0) * kw;
    activity += pt;
    breakdown.push(`pressure test ${Number(pt.toFixed(3))} ${u}${kw ? ` (${kw.toFixed(1)} kW system)` : ''}`);
  }

  let expected: number;
  if (hasActivityNorm) {
    expected = activity > 0 ? activity + (n.perJob ?? 0) : 0;
    if (activity > 0 && n.perJob) breakdown.push(`handling allowance ${n.perJob} ${u}`);
  } else {
    expected = n.perJob ?? 0;
    breakdown.push(`${n.perJob} ${u} per job`);
  }
  return { expected: Number(expected.toFixed(3)), breakdown, activity: activities.join(' / ') || 'this job' };
}

export interface IssuePlanLine {
  expected: number;
  /** Upper limit before a reason is required (expected × (1 + tolerance)). */
  limit: number;
  unit: string;
  breakdown: string[];
}

/**
 * The quantity of an item the store should issue for this job, or undefined
 * when the item isn't budgeted per job (e.g. ordinary spares).
 */
export function issuePlan(item: InventoryItem, job: JobFacts, norms: ConsumptionNorms = DEFAULT_NORMS): IssuePlanLine | undefined {
  const tol = 1 + norms.tolerancePct / 100;
  if (item.type === 'Refrigerant') {
    const exp = expectedRefrigerant(job.equipment, job.jobType, job.pipeLengthM, norms);
    const factor = toGrams(1, item.unit);
    if (!factor || (exp.basis === 'unknown' && exp.expectedG === 0)) return undefined;
    const expected = exp.expectedG / factor;
    return {
      expected: Number(expected.toFixed(3)),
      limit: Number((expected * tol).toFixed(3)),
      unit: item.unit,
      breakdown: exp.breakdown,
    };
  }
  const c = expectedConsumable(item, job);
  if (!c) return undefined;
  return { expected: c.expected, limit: Number((c.expected * tol).toFixed(3)), unit: item.unit, breakdown: c.breakdown };
}

/** Converts an item quantity to grams when the item is weighed in kg/g. */
export function toGrams(qty: number, unit: string): number | undefined {
  const u = unit.trim().toLowerCase();
  if (u === 'kg') return qty * 1000;
  if (u === 'g') return qty;
  return undefined;
}

export type AlertCode = 'over-consumption' | 'unexpected-use' | 'refrigerant-mismatch' | 'repeat-charge' | 'no-baseline';

export interface EvaluatedAlert {
  code: AlertCode;
  itemId: string;
  severity: AlertSeverity;
  expected: number;
  actual: number;
  unit: string;
  message: string;
}

export interface MaterialUsage {
  item: InventoryItem;
  /** Net quantity consumed (issues − returns), in the item's unit. */
  qty: number;
}

export interface PriorCharge {
  complaintId: string;
  ticketNo: string;
  at: string;
}

function severityFor(ratio: number, norms: ConsumptionNorms): AlertSeverity | undefined {
  if (ratio > 1 + norms.criticalPct / 100) return 'critical';
  if (ratio > 1 + norms.tolerancePct / 100) return 'warning';
  return undefined;
}

const fmt = (n: number, digits = 2) => Number(n.toFixed(digits)).toString();

/**
 * Evaluates the materials consumed on a job against the norms.
 * `priorCharges` are earlier refrigerant charges on the same serial number.
 */
export function evaluateJob(
  complaint: JobFacts & Pick<Complaint, 'createdAt'>,
  usage: MaterialUsage[],
  norms: ConsumptionNorms = DEFAULT_NORMS,
  priorCharges: PriorCharge[] = [],
): EvaluatedAlert[] {
  const alerts: EvaluatedAlert[] = [];
  const eq = complaint.equipment;

  const refrigerantUsage = usage.filter((u) => u.item.type === 'Refrigerant' && u.qty > 0);
  let totalRefG = 0;

  for (const u of refrigerantUsage) {
    const grams = toGrams(u.qty, u.item.unit);
    if (grams === undefined) continue;
    totalRefG += grams;
    if (eq.refrigerant && eq.refrigerant !== 'None' && u.item.refrigerant && u.item.refrigerant !== eq.refrigerant) {
      alerts.push({
        code: 'refrigerant-mismatch',
        itemId: u.item.id,
        severity: 'critical',
        expected: 0,
        actual: grams,
        unit: 'g',
        message: `${u.item.refrigerant} issued to a ${eq.refrigerant} unit. Mixing refrigerants damages the system, so check whether the stock was diverted or mis-recorded.`,
      });
    }
  }

  if (refrigerantUsage.length > 0 && totalRefG > 0) {
    const firstId = refrigerantUsage[0].item.id;
    const exp = expectedRefrigerant(eq, complaint.jobType, complaint.pipeLengthM, norms);
    if (exp.basis === 'unknown' && !(norms.jobs[complaint.jobType ?? 'Other']?.pipeCharge && exp.expectedG > 0)) {
      alerts.push({
        code: 'no-baseline',
        itemId: firstId,
        severity: 'info',
        expected: 0,
        actual: totalRefG,
        unit: 'g',
        message: `${fmt(totalRefG, 0)} g refrigerant used but there's no baseline to check it against. Add the capacity, refrigerant type or nameplate charge.`,
      });
    } else if (exp.expectedG === 0) {
      alerts.push({
        code: 'unexpected-use',
        itemId: firstId,
        severity: 'warning',
        expected: 0,
        actual: totalRefG,
        unit: 'g',
        message: `${fmt(totalRefG, 0)} g refrigerant used on a "${complaint.jobType ?? 'unspecified'}" job, which normally needs none.`,
      });
    } else {
      const ratio = totalRefG / exp.expectedG;
      const sev = severityFor(ratio, norms);
      if (sev) {
        alerts.push({
          code: 'over-consumption',
          itemId: firstId,
          severity: sev,
          expected: exp.expectedG,
          actual: totalRefG,
          unit: 'g',
          message: `Refrigerant use ${fmt(totalRefG, 0)} g is ${Math.round((ratio - 1) * 100)}% above the expected ${exp.expectedG} g (${exp.breakdown.join('; ')}).`,
        });
      }
    }

    const windowMs = norms.repeatWindowDays * 86400000;
    const now = new Date(complaint.createdAt).getTime();
    const recent = priorCharges.filter((p) => {
      const t = new Date(p.at).getTime();
      return now - t >= 0 && now - t <= windowMs;
    });
    if (recent.length > 0) {
      alerts.push({
        code: 'repeat-charge',
        itemId: firstId,
        severity: recent.length > 1 ? 'critical' : 'warning',
        expected: 0,
        actual: totalRefG,
        unit: 'g',
        message: `This unit (S/N ${eq.serialNo || 'n/a'}) also received refrigerant ${recent.length} time(s) in the last ${norms.repeatWindowDays} days (${recent.map((r) => r.ticketNo).join(', ')}). That points to a leak that hasn't been fixed.`,
      });
    }
  }

  for (const u of usage) {
    if (u.item.type === 'Refrigerant' || u.qty <= 0) continue;
    const exp = expectedConsumable(u.item, complaint);
    if (!exp) continue;
    if (exp.expected === 0) {
      alerts.push({
        code: 'unexpected-use',
        itemId: u.item.id,
        severity: 'warning',
        expected: 0,
        actual: u.qty,
        unit: u.item.unit,
        message: `${fmt(u.qty)} ${u.item.unit} of ${u.item.name} used, but this job records no ${exp.activity}.`,
      });
      continue;
    }
    const ratio = u.qty / exp.expected;
    const sev = severityFor(ratio, norms);
    if (sev) {
      alerts.push({
        code: 'over-consumption',
        itemId: u.item.id,
        severity: sev,
        expected: exp.expected,
        actual: u.qty,
        unit: u.item.unit,
        message: `${u.item.name}: ${fmt(u.qty)} ${u.item.unit} used against an expected ${fmt(exp.expected)} ${u.item.unit} (${Math.round((ratio - 1) * 100)}% over; ${exp.breakdown.join(', ')}).`,
      });
    }
  }

  return alerts;
}

export interface TechnicianTrend {
  technicianId: string;
  jobs: number;
  expectedG: number;
  actualG: number;
  ratio: number;
  flagged: boolean;
}

/**
 * Aggregates refrigerant use against expectation per technician, so that a
 * technician who is consistently over (even if each job is within tolerance)
 * stands out.
 */
export function technicianTrends(
  jobs: { technicianId?: string; expectedG: number; actualG: number }[],
  norms: ConsumptionNorms = DEFAULT_NORMS,
  minJobs = 3,
): TechnicianTrend[] {
  const map = new Map<string, TechnicianTrend>();
  for (const j of jobs) {
    if (j.technicianId === undefined || j.expectedG <= 0 || j.actualG <= 0) continue;
    const t = map.get(j.technicianId) ?? {
      technicianId: j.technicianId,
      jobs: 0,
      expectedG: 0,
      actualG: 0,
      ratio: 0,
      flagged: false,
    };
    t.jobs += 1;
    t.expectedG += j.expectedG;
    t.actualG += j.actualG;
    map.set(j.technicianId, t);
  }
  return [...map.values()]
    .map((t) => {
      const ratio = t.actualG / t.expectedG;
      return { ...t, ratio, flagged: t.jobs >= minJobs && ratio > 1 + norms.tolerancePct / 100 };
    })
    .sort((a, b) => b.ratio - a.ratio);
}
