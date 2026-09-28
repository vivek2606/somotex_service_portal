// Sample data for trying the app: about two months of service-centre work.
//
// Everything is created through the normal data operations (so budgets,
// alerts, ticket numbers and the timeline behave exactly as in real use),
// with the clock moved back and every record id prefixed "demo-" so that
// removeDemoData() can take it all out again.

import { diagnose, type Answers } from '../lib/diagnosis';
import { issuePlan } from '../lib/consumption';
import { applyWarranty } from '../lib/warranty';
import { DEMO_PREFIX, newId, runtime, type ServiceDB } from './db';
import { seedIfEmpty } from './seed';
import { contentAt, refillCylinder, registerCylinder, weighIn, weighOut } from './cylinders';
import { createRequest, decideRequest, dispatchRequest, receiveRequest } from './requests';
import { localDay, scheduleVisit } from './visits';
import {
  acknowledgeAlert,
  assignTechnician,
  checkIssue,
  confirmedCauseCounts,
  createComplaint,
  issueToComplaint,
  logCustomerContact,
  receiveStock,
  recomputeStock,
  setStatus,
  updateJobDetails,
} from './service';
import type { AppSettings } from './settings';
import { SYNCED_TABLES } from './db';
import type {
  BrazingMethod,
  CapacityUnit,
  Complaint,
  Customer,
  Equipment,
  InventoryItem,
  JobType,
  Priority,
  ProductCategory,
  Refrigerant,
} from './types';
import { VISIT_SLOTS } from './types';

/** Small deterministic random generator so the demo looks the same each time. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const DAY = 86400000;
const HOUR = 3600000;

interface Unit {
  brand: string;
  category: ProductCategory;
  model: string;
  capacity?: number;
  capacityUnit?: CapacityUnit;
  refrigerant?: Refrigerant;
  nameplateChargeG?: number;
}

const UNITS: Record<string, Unit> = {
  mideaSplit12: { brand: 'Midea', category: 'Residential AC', model: 'MSAFB-12CRN8', capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32' },
  mideaSplit18: { brand: 'Midea', category: 'Residential AC', model: 'MSAFC-18CRN8', capacity: 18000, capacityUnit: 'BTU/h', refrigerant: 'R32' },
  mideaSplit24: { brand: 'Midea', category: 'Residential AC', model: 'MOV-24HRN1', capacity: 24000, capacityUnit: 'BTU/h', refrigerant: 'R410A' },
  mideaCassette: { brand: 'Midea', category: 'Commercial AC', model: 'MCD-48HRN1 cassette', capacity: 48000, capacityUnit: 'BTU/h', refrigerant: 'R410A' },
  mideaVrf: { brand: 'Midea', category: 'VRF / VRV', model: 'MDV-V5 280', capacity: 28, capacityUnit: 'kW', refrigerant: 'R410A', nameplateChargeG: 9900 },
  tamashiSplit12: { brand: 'Tamashi', category: 'Residential AC', model: 'TSA-12R32', capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32' },
  tamashiSplit18: { brand: 'Tamashi', category: 'Residential AC', model: 'TSA-18R410', capacity: 18000, capacityUnit: 'BTU/h', refrigerant: 'R410A' },
  bruhmSplit12: { brand: 'Bruhm', category: 'Residential AC', model: 'BAS-12CRN', capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32' },
  auxSplit12: { brand: 'AUX', category: 'Residential AC', model: 'ASW-H12B4', capacity: 12000, capacityUnit: 'BTU/h', refrigerant: 'R32' },
  chigoSplit9: { brand: 'Chigo', category: 'Residential AC', model: 'CS-25H3A', capacity: 9000, capacityUnit: 'BTU/h', refrigerant: 'R22' },
  sharpSplit18: { brand: 'Sharp', category: 'Residential AC', model: 'AH-A18', capacity: 18000, capacityUnit: 'BTU/h', refrigerant: 'R410A' },
  bekoFridge: { brand: 'Beko', category: 'Refrigerator', model: 'RDSE450', capacity: 450, capacityUnit: 'L', refrigerant: 'R600a' },
  bruhmFridge: { brand: 'Bruhm', category: 'Refrigerator', model: 'BFD-300', capacity: 300, capacityUnit: 'L', refrigerant: 'R600a' },
  sharpFridge: { brand: 'Sharp', category: 'Refrigerator', model: 'SJ-K45', capacity: 420, capacityUnit: 'L', refrigerant: 'R134a' },
  tamashiFreezer: { brand: 'Tamashi', category: 'Chest Freezer', model: 'TCF-300', capacity: 300, capacityUnit: 'L', refrigerant: 'R600a' },
  tamashiDisplay: { brand: 'Tamashi', category: 'Chest Freezer', model: 'TCF-500G display', capacity: 500, capacityUnit: 'L', refrigerant: 'R290' },
  bruhmFreezer: { brand: 'Bruhm', category: 'Chest Freezer', model: 'BCF-200', capacity: 200, capacityUnit: 'L', refrigerant: 'R600a' },
  bekoWasher: { brand: 'Beko', category: 'Washing Machine', model: 'WTV8612' },
  bruhmWasher: { brand: 'Bruhm', category: 'Washing Machine', model: 'BWM-7 twin tub' },
  tamashiTv: { brand: 'Tamashi', category: 'Television', model: 'TLED-43' },
  sharpTv: { brand: 'Sharp', category: 'Television', model: '2T-C42' },
  tamashiCooker: { brand: 'Tamashi', category: 'Gas Cooker', model: 'TGC-4' },
  bruhmCooker: { brand: 'Bruhm', category: 'Gas Cooker', model: 'BGC-5' },
  sharpMicrowave: { brand: 'Sharp', category: 'Microwave', model: 'R-20' },
};

interface Scenario {
  units: (keyof typeof UNITS)[];
  complaintType: string;
  statements: string[];
  answers: Answers;
  job: JobType;
  cause: string;
  resolution: string;
  priority?: Priority;
  pipeM?: [number, number];
  joints?: [number, number];
  purge?: boolean;
  pressureTest?: boolean;
  flushM?: number;
  recoveredG?: number;
  /** Refrigerant issued as a share of the job's budget (the gas actually used). */
  gasShare?: [number, number];
  /** Spares by starter SKU. */
  spares?: string[];
  charge?: [number, number];
}

const SCENARIOS: Record<string, Scenario> = {
  acLeak: {
    units: ['mideaSplit12', 'mideaSplit18', 'tamashiSplit12', 'bruhmSplit12', 'auxSplit12', 'sharpSplit18', 'tamashiSplit18', 'mideaSplit24'],
    complaintType: 'Not cooling / low cooling',
    statements: [
      'The AC runs but only blows normal air, it stopped cooling two days ago.',
      'It is not cooling at all, the outdoor unit is running and there is some ice on the small pipe.',
      'Cooling is very weak since last week, they refilled gas last year also.',
    ],
    answers: { power: 'Yes', remote: 'Yes', fan: 'Yes', air: 'Room temperature', outdoor: 'Yes', regas: 'Yes', ice: 'Yes' },
    job: 'Leak Repair + Full Recharge',
    cause: 'ac-gas-leak',
    resolution: 'Found leak at the indoor flare joint. Re-flared and brazed, pressure tested with nitrogen, vacuumed and weighed in the full charge.',
    pipeM: [4, 9],
    joints: [2, 4],
    purge: true,
    pressureTest: true,
    gasShare: [0.9, 1.08],
    charge: [9000, 25000],
  },
  acTopUp: {
    units: ['chigoSplit9', 'mideaSplit12', 'tamashiSplit12', 'auxSplit12'],
    complaintType: 'Not cooling / low cooling',
    statements: ['Cooling is less than before, please come and refill the gas.', 'The room takes very long to cool now.'],
    answers: { power: 'Yes', fan: 'Yes', air: 'Slightly cool', outdoor: 'Yes', service: '> 1 year' },
    job: 'Gas Top-up',
    cause: 'ac-gas-leak',
    resolution: 'Low suction pressure. Topped up refrigerant. Customer advised a full leak test if cooling drops again.',
    gasShare: [0.85, 1.1],
    charge: [6000, 15000],
  },
  acCapacitor: {
    units: ['mideaSplit18', 'tamashiSplit12', 'bruhmSplit12', 'sharpSplit18'],
    complaintType: 'Not cooling / low cooling',
    statements: ['Indoor unit is on but the outdoor unit is not starting, only humming.', 'Fan blows but no cooling, outside unit silent.'],
    answers: { power: 'Yes', fan: 'Yes', air: 'Room temperature', outdoor: 'No' },
    job: 'PCB / Electrical Repair',
    cause: 'ac-capacitor',
    resolution: 'Run capacitor failed (measured 18 µF of 35 µF). Replaced capacitor, checked running current.',
    spares: ['SP-CAP-35'],
    charge: [5000, 12000],
  },
  acService: {
    units: ['mideaSplit12', 'mideaCassette', 'tamashiSplit18', 'auxSplit12'],
    complaintType: 'Preventive maintenance',
    statements: ['Please service the office ACs, there is a bad smell.', 'Annual service for our units.'],
    answers: { power: 'Yes', fan: 'Yes', air: 'Slightly cool', smell: 'Musty / bad smell', service: 'Never' },
    job: 'Preventive Maintenance',
    cause: 'ac-dirty',
    resolution: 'Cleaned filters, indoor coil and blower, washed outdoor condenser. Temperature drop 11 °C after service.',
    charge: [15000, 30000],
  },
  acDrain: {
    units: ['mideaSplit18', 'bruhmSplit12', 'tamashiSplit12'],
    complaintType: 'Water leakage',
    statements: ['Water is dripping from the indoor unit onto the wall.', 'The AC is leaking water on the bed.'],
    answers: { power: 'Yes', fan: 'Yes', air: 'Cold', water: 'Yes' },
    job: 'Mechanical Repair',
    cause: 'ac-drain',
    resolution: 'Drain pipe blocked with dirt and insects. Cleared with nitrogen and corrected the slope.',
    charge: [5000, 10000],
  },
  acInstall: {
    units: ['mideaSplit12', 'mideaSplit18', 'tamashiSplit12', 'bruhmSplit12'],
    complaintType: 'Installation request',
    statements: ['New AC bought from your showroom, please install in the bedroom.', 'Installation needed for two units at the new office.'],
    answers: {},
    job: 'New Installation',
    cause: 'ac-install',
    resolution: 'Installed with pipe run as measured, pressure tested with nitrogen, vacuumed, added charge for the extra pipe.',
    pipeM: [6, 12],
    joints: [0, 2],
    purge: true,
    pressureTest: true,
    gasShare: [0.8, 1.1],
    charge: [25000, 45000],
  },
  vrfCompressor: {
    units: ['mideaVrf'],
    complaintType: 'Not cooling / low cooling',
    statements: ['The whole floor is not cooling, the outdoor unit shows an error and trips.'],
    answers: { power: 'Yes', fan: 'Yes', air: 'Warm', outdoor: 'Starts then stops', trip: 'Yes', error: 'E4 / P1' },
    job: 'Compressor Replacement',
    cause: 'ac-compressor',
    resolution: 'Compressor burnt out (acid in oil). Recovered refrigerant, replaced compressor and drier, flushed the circuit, pressure tested, vacuumed and recharged to nameplate.',
    priority: 'Critical',
    pipeM: [5, 5],
    joints: [6, 8],
    purge: true,
    pressureTest: true,
    flushM: 18,
    recoveredG: 6500,
    gasShare: [0.95, 1.05],
    spares: ['SP-FILTER-DRIER'],
    charge: [450000, 700000],
  },
  fridgeLeak: {
    units: ['bekoFridge', 'bruhmFridge', 'tamashiFreezer', 'bruhmFreezer', 'tamashiDisplay', 'sharpFridge'],
    complaintType: 'Not cooling / low cooling',
    statements: ['The freezer is not freezing, the motor runs all the time.', 'Fridge is warm inside but I can hear the compressor running.'],
    answers: { power: 'Yes', comp: 'Yes', cool: 'Nothing cools', frost: 'No', regas: "Don't know" },
    job: 'Leak Repair + Full Recharge',
    cause: 'fr-gas-leak',
    resolution: 'Leak on the condenser loop. Brazed, replaced the filter drier, pressure tested, vacuumed and charged to nameplate.',
    joints: [2, 3],
    purge: true,
    pressureTest: true,
    gasShare: [0.9, 1.1],
    spares: ['SP-FILTER-DRIER'],
    charge: [25000, 45000],
  },
  fridgeRelay: {
    units: ['bekoFridge', 'bruhmFreezer', 'tamashiFreezer'],
    complaintType: 'Not cooling / low cooling',
    statements: ['There is a clicking sound at the back and it is not cooling.'],
    answers: { power: 'Yes', comp: 'Clicks on and off', cool: 'Nothing cools' },
    job: 'PCB / Electrical Repair',
    cause: 'fr-relay',
    resolution: 'PTC starting relay faulty. Replaced relay, compressor starting normally.',
    charge: [8000, 15000],
  },
  fridgeThermostat: {
    units: ['bruhmFridge', 'sharpFridge', 'tamashiFreezer'],
    complaintType: 'Other',
    statements: ['Everything in the fridge is freezing, even the vegetables.'],
    answers: { power: 'Yes', comp: 'Yes', cool: 'Over-freezing' },
    job: 'PCB / Electrical Repair',
    cause: 'fr-thermostat',
    resolution: 'Thermostat contacts stuck. Replaced thermostat.',
    spares: ['SP-THERMO-FR'],
    charge: [8000, 15000],
  },
  washerDrain: {
    units: ['bekoWasher', 'bruhmWasher'],
    complaintType: 'Not spinning / draining',
    statements: ['Water stays in the drum after washing, it does not drain.'],
    answers: { power: 'Yes', fill: 'Yes', drain: 'No', spin: 'No' },
    job: 'Mechanical Repair',
    cause: 'wm-drain',
    resolution: 'Drain pump blocked by a coin and jammed. Replaced drain pump.',
    spares: ['SP-WM-DRAIN'],
    charge: [10000, 20000],
  },
  tvBacklight: {
    units: ['tamashiTv', 'sharpTv'],
    complaintType: 'No picture / no sound',
    statements: ['There is sound but the screen is black.'],
    answers: { standby: 'Yes', picture: 'No picture', sound: 'Yes' },
    job: 'PCB / Electrical Repair',
    cause: 'tv-backlight',
    resolution: 'Two LED backlight strips failed. Replaced the backlight set.',
    charge: [25000, 40000],
  },
  cookerLeak: {
    units: ['tamashiCooker', 'bruhmCooker'],
    complaintType: 'Burner / ignition fault',
    statements: ['There is a gas smell in the kitchen near the cooker even when it is off.'],
    answers: { smell: 'Yes', spark: 'Yes', flame: 'Normal blue' },
    job: 'Mechanical Repair',
    cause: 'gc-leak',
    resolution: 'Hose cracked near the regulator. Replaced hose and clamps, soap-tested all joints.',
    priority: 'Critical',
    charge: [5000, 10000],
  },
  cookerIgnition: {
    units: ['tamashiCooker', 'bruhmCooker'],
    complaintType: 'Burner / ignition fault',
    statements: ['The auto ignition does not spark, we use a match to light it.'],
    answers: { smell: 'No', spark: 'No', flame: 'Normal blue' },
    job: 'PCB / Electrical Repair',
    cause: 'gc-ignition',
    resolution: 'Ignition module faulty. Replaced ignition unit.',
    spares: ['SP-GC-IGN'],
    charge: [8000, 15000],
  },
  microwave: {
    units: ['sharpMicrowave'],
    complaintType: 'Not heating',
    statements: ['The microwave runs and the plate turns but the food stays cold.'],
    answers: { power: 'Yes', heat: 'No', turntable: 'Yes', noise: 'No' },
    job: 'PCB / Electrical Repair',
    cause: 'mw-magnetron',
    resolution: 'Magnetron filament open. Replaced magnetron.',
    spares: ['SP-MW-MAG'],
    charge: [15000, 25000],
  },
};

/** Weighted list of what comes in; AC gas work dominates, as it does in practice. */
const MIX: [string, number][] = [
  ['acLeak', 9],
  ['acTopUp', 5],
  ['acCapacitor', 4],
  ['acService', 3],
  ['acDrain', 3],
  ['acInstall', 4],
  ['vrfCompressor', 1],
  ['fridgeLeak', 5],
  ['fridgeRelay', 2],
  ['fridgeThermostat', 2],
  ['washerDrain', 2],
  ['tvBacklight', 2],
  ['cookerLeak', 1],
  ['cookerIgnition', 2],
  ['microwave', 1],
];

const PEOPLE = [
  'Chinedu Okafor', 'Aisha Bello', 'Tunde Adeyemi', 'Ngozi Eze', 'Ibrahim Musa', 'Funmilayo Ogunleye',
  'Emeka Nwosu', 'Halima Abubakar', 'Segun Balogun', 'Amaka Obi', 'Yusuf Garba', 'Bisi Adebayo',
  'Chioma Nnamdi', 'Kelechi Uche', 'Zainab Lawal', 'Oluwaseun Afolabi', 'Nkechi Onyeka', 'Musa Danjuma',
];
const BUSINESSES = [
  'Lekki Grand Hotel', 'Marina Business Suites', 'Wuse Medical Centre', 'Ikeja Food Court', 'Garki Guest House',
  'Bodija Pharmacy', 'Trans-Amadi Cold Store', 'Sabon Gari Supermarket', 'Victoria Island Offices', 'Ring Road Clinic',
];
const DEALERS = ['Alaba Electronics Traders', 'Main Market Appliances'];

/** Areas and phone prefixes per branch city (used for realistic addresses). */
const PLACES: Record<string, { city: string; areas: string[] }> = {
  'Lagos (Head Office)': { city: 'Lagos', areas: ['Lekki Phase 1', 'Ikeja GRA', 'Surulere', 'Victoria Island', 'Yaba', 'Ajah', 'Magodo'] },
  Abuja: { city: 'Abuja', areas: ['Wuse II', 'Garki', 'Maitama', 'Gwarinpa', 'Asokoro'] },
  Ibadan: { city: 'Ibadan', areas: ['Bodija', 'Ring Road', 'Challenge', 'Oluyole Estate'] },
  Onitsha: { city: 'Onitsha', areas: ['GRA', 'Fegge', 'Awada', 'Main Market'] },
  'Port Harcourt': { city: 'Port Harcourt', areas: ['Trans-Amadi', 'GRA Phase 2', 'Rumuola', 'D-Line'] },
  Kano: { city: 'Kano', areas: ['Nassarawa GRA', 'Sabon Gari', 'Bompai', 'Tarauni'] },
};

/** Technicians per branch; Lagos has an AC team (one of whom over-uses gas) and an appliance technician. */
const TECHNICIANS = [
  { name: 'Emeka Nwankwo', phone: '0803 410 0001', skills: 'Split AC, VRF, commercial refrigeration', branch: 'Lagos (Head Office)', ac: true, gas: 1.0 },
  { name: 'Tunde Bakare', phone: '0806 410 0002', skills: 'Split AC, installations', branch: 'Lagos (Head Office)', ac: true, gas: 1.35 },
  { name: 'Bisi Adeyemi', phone: '0813 410 0003', skills: 'Fridges, freezers, washing machines, TVs', branch: 'Lagos (Head Office)', ac: false, gas: 1.02 },
  { name: 'Ibrahim Sule', phone: '0703 410 0004', skills: 'AC and refrigeration', branch: 'Abuja', ac: true, gas: 1.05 },
  { name: 'Kunle Ajayi', phone: '0816 410 0005', skills: 'AC, fridges, appliances', branch: 'Ibadan', ac: true, gas: 1.0 },
  { name: 'Obinna Eze', phone: '0905 410 0006', skills: 'AC, fridges, appliances', branch: 'Onitsha', ac: true, gas: 1.08 },
  { name: 'Chidi Okeke', phone: '0809 410 0007', skills: 'AC, cold rooms, appliances', branch: 'Port Harcourt', ac: true, gas: 1.0 },
  { name: 'Sani Garba', phone: '0802 410 0008', skills: 'AC, fridges, appliances', branch: 'Kano', ac: true, gas: 1.02 },
];

/** Example prices (NGN) used only where an item has no unit cost yet. */
const EXAMPLE_COSTS: Record<string, number> = {
  'REF-R32': 16000, 'REF-R410A': 20000, 'REF-R22': 18000, 'REF-R134A': 18000, 'REF-R600A': 25000, 'REF-R290': 25000,
  'GAS-O2': 5000, 'GAS-C2H2': 12000, 'GAS-LPG': 1300, 'GAS-MAPP': 40000, 'GAS-N2': 6000, 'FLUSH-AGENT': 15000,
  'CON-ROD-15': 2500, 'CON-ROD-CU': 800, 'SP-CAP-35': 6000, 'SP-CAP-FAN': 3500, 'SP-FILTER-DRIER': 4000,
  'SP-THERMO-FR': 15000, 'SP-WM-DRAIN': 35000, 'SP-MW-MAG': 45000, 'SP-GC-IGN': 20000,
};

/** Opening stock (received 60 days ago) and a top-up 30 days ago. */
const RECEIPTS: Record<string, [number, number]> = {
  'REF-R32': [40, 25], 'REF-R410A': [60, 40], 'REF-R22': [15, 5], 'REF-R134A': [8, 0], 'REF-R600A': [3, 2], 'REF-R290': [2, 0],
  'GAS-O2': [30, 10], 'GAS-C2H2': [12, 6], 'GAS-LPG': [12, 6], 'GAS-MAPP': [4, 2], 'GAS-N2': [40, 20], 'FLUSH-AGENT': [20, 0],
  'CON-ROD-15': [200, 100], 'CON-ROD-CU': [200, 0], 'SP-CAP-35': [12, 0], 'SP-CAP-FAN': [10, 0], 'SP-FILTER-DRIER': [20, 0],
  'SP-THERMO-FR': [6, 0], 'SP-WM-DRAIN': [4, 2], 'SP-MW-MAG': [2, 1], 'SP-GC-IGN': [5, 0],
};

export async function hasDemoData(db: ServiceDB) {
  return (await db.complaints.where('id').startsWith(DEMO_PREFIX).count()) > 0;
}

export async function loadDemoData(db: ServiceDB, settings: AppSettings, days = 60) {
  if (await hasDemoData(db)) throw new Error('Demo data is already loaded. Remove it first to load it again.');
  await seedIfEmpty(db);
  const r = rng(20260928);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);
  const whole = (lo: number, hi: number) => Math.round(between(lo, hi));
  const start = Date.now() - days * DAY;
  const clock = { t: start };
  const at = (t: number) => {
    clock.t = Math.min(t, Date.now() - 60000);
  };

  const prevNow = runtime.now;
  const prevPrefix = runtime.idPrefix;
  runtime.now = () => new Date(clock.t);
  runtime.idPrefix = DEMO_PREFIX;
  try {
    const items = await db.items.toArray();
    const bySku = new Map(items.map((i) => [i.sku, i]));
    const gasFor = (pred: (i: InventoryItem) => boolean) => items.find((i) => i.active && pred(i));

    // Technicians
    // Use the branch names configured in Settings; demo places follow the defaults.
    const branches = settings.branches.length ? settings.branches : Object.keys(PLACES);
    const branchOf = (name: string) => (branches.includes(name) ? name : branches[0]);
    const techs: { id: string; branch: string; ac: boolean; gas: number }[] = [];
    for (const t of TECHNICIANS) {
      const id = newId();
      const branch = branchOf(t.branch);
      await db.technicians.add({ id, name: t.name, phone: t.phone, skills: t.skills, active: true, branch });
      techs.push({ id, branch, ac: t.ac, gas: t.gas });
    }

    // Stock
    for (const [sku, [opening, topUp]] of Object.entries(RECEIPTS)) {
      const item = bySku.get(sku);
      if (!item) continue;
      const cost = item.unitCost > 0 ? undefined : EXAMPLE_COSTS[sku];
      at(start - 2 * DAY);
      if (opening) await receiveStock(db, settings, item.id, opening, 'Demo opening stock', cost);
      at(start + 30 * DAY);
      if (topUp) await receiveStock(db, settings, item.id, topUp, 'Demo GRN 1042');
    }

    // Tagged cylinders in the Lagos store (their gas is part of the stock received above).
    const cylDefs: { tag: string; sku: string; tareKg?: number; capacityL?: number; reading: number }[] = [
      { tag: 'R32-01', sku: 'REF-R32', tareKg: 7.5, reading: 17.5 },
      { tag: 'R32-02', sku: 'REF-R32', tareKg: 7.5, reading: 17.4 },
      { tag: 'R410A-01', sku: 'REF-R410A', tareKg: 8.2, reading: 19.5 },
      { tag: 'R410A-02', sku: 'REF-R410A', tareKg: 8.2, reading: 19.4 },
      { tag: 'N2-01', sku: 'GAS-N2', capacityL: 50, reading: 150 },
      { tag: 'O2-01', sku: 'GAS-O2', capacityL: 50, reading: 150 },
    ];
    at(start - 2 * DAY);
    const cylinderIds: string[] = [];
    for (const d of cylDefs) {
      const item = bySku.get(d.sku);
      if (!item) continue;
      cylinderIds.push(
        await registerCylinder(db, settings, { tag: d.tag, itemId: item.id, tareKg: d.tareKg, capacityL: d.capacityL, reading: d.reading, alreadyInStock: true }),
      );
    }
    let lossShown = false;
    let overdueShown = false;

    // Customers are created with their first complaint and reused for repeat business.
    const customers: { id?: string; branch: string; data: Omit<Customer, 'id' | 'createdAt'>; units: Equipment[] }[] = [];
    const phone = () => `${pick(['0803', '0806', '0813', '0816', '0703', '0706', '0905', '0802'])} ${whole(100, 999)} ${whole(1000, 9999)}`;
    // Lagos, as head office, handles the most calls.
    const branchWeights = branches.flatMap((b, i) => Array<string>(i === 0 ? 4 : 1).fill(b));
    const place = (branch: string) => PLACES[branch] ?? { city: branch.replace(/\s*\(.*\)/, ''), areas: ['Central'] };
    const add = (name: string, type: Customer['type'], street: string) => {
      // Every branch gets a few customers; after that, Lagos gets the most.
      const branch = customers.length < branches.length * 2 ? branches[customers.length % branches.length] : pick(branchWeights);
      const p = place(branch);
      customers.push({ branch, data: { name, phone: phone(), address: `${whole(2, 48)} ${street}, ${pick(p.areas)}`, city: p.city, type }, units: [] });
    };
    for (const name of PEOPLE) add(name, 'Individual', pick(['Adeola Street', 'Okonkwo Close', 'Bello Crescent', 'Unity Road', 'Ahmadu Bello Way']));
    for (const name of BUSINESSES) add(name, 'Business', pick(['Admiralty Way', 'Aminu Kano Crescent', 'Airport Road', 'Adeniran Ogunsanya Street']));
    for (const name of DEALERS) add(name, 'Dealer', pick(['Market Road', 'New Market Road']));

    const weighted: string[] = MIX.flatMap(([k, w]) => Array<string>(w).fill(k));
    const count = 48;
    const confirmed = await confirmedCauseCounts(db);
    let serial = 1000;

    // Most jobs are finished; recent ones cover every open stage, and a few
    // older ones are still open so the overdue view has something in it.
    type Stage = 'Registered' | 'Assigned' | 'In Progress' | 'Awaiting Parts' | 'Resolved' | 'Closed';
    const recent: Stage[] = ['Registered', 'Assigned', 'In Progress', 'Awaiting Parts', 'Resolved', 'Assigned', 'In Progress', 'Closed'];
    const overdue: Stage[] = ['In Progress', 'Awaiting Parts', 'Assigned'];
    const plans: { day: number; key: string; stage: Stage }[] = [];
    for (const stage of recent) plans.push({ day: days - between(0.1, 2.5), key: pick(weighted), stage });
    for (const stage of overdue) plans.push({ day: days - between(5, 9), key: pick(weighted), stage });
    while (plans.length < count) plans.push({ day: between(0.5, days - 3), key: pick(weighted), stage: 'Closed' });
    plans.sort((a, b) => a.day - b.day);

    // A leaking unit that is only topped up comes back: repeat charging.
    const repeatUnit: { customer?: (typeof customers)[number]; unit?: Equipment } = {};

    for (const [n, plan] of plans.entries()) {
      const sc = SCENARIOS[plan.key];
      // Head office gets the most calls.
      const callBranch = pick(branchWeights);
      let cust = pick(customers.filter((c) => c.branch === callBranch).length ? customers.filter((c) => c.branch === callBranch) : customers);
      let eq: Equipment;
      const reuse = plan.key === 'acTopUp' && repeatUnit.unit && r() < 0.7;
      if (reuse) {
        cust = repeatUnit.customer!;
        eq = repeatUnit.unit!;
      } else {
        const u = UNITS[pick(sc.units)];
        eq = {
          ...u,
          serialNo: `${u.brand.slice(0, 2).toUpperCase()}${u.model.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase()}-${serial++}`,
          purchaseDate: new Date(start - whole(30, 900) * DAY).toISOString().slice(0, 10),
          warranty: 'Unknown',
        };
        cust.units.push(eq);
      }
      if (plan.key === 'acTopUp' && !reuse) {
        repeatUnit.customer = cust;
        repeatUnit.unit = eq;
      }

      const created = start + plan.day * DAY;
      // Warranty as on the day of the call, from the invoice date and the rules in Settings.
      eq = applyWarranty(eq, settings.warrantyRules, new Date(created));
      const statement = pick(sc.statements);
      const answers = sc.answers;
      const diagnosis = diagnose(eq.category, answers, `${sc.complaintType} ${statement}`, confirmed);
      const priority: Priority = sc.priority ?? diagnosis.priority ?? (cust.data.type === 'Business' && r() < 0.5 ? 'High' : 'Normal');

      at(created);
      const id = await createComplaint(db, settings, {
        branch: cust.branch,
        customerId: cust.id,
        customer: cust.id ? undefined : cust.data,
        equipment: eq,
        complaintType: sc.complaintType,
        description: n % 5 === 0 ? 'Customer asked for a call before the visit.' : '',
        customerStatement: statement,
        callerName: cust.data.type === 'Business' ? pick(['Front office', 'Facilities manager', 'Accounts']) : undefined,
        preferredVisit: pick(['Morning', 'After 2 pm', 'Any time', 'Saturday morning', undefined]),
        source: pick(['Phone', 'Phone', 'Phone', 'WhatsApp', 'Walk-in', 'Dealer'] as const),
        priority,
        diagnosis: {
          answers,
          suggested: diagnosis.suggestions.map((s) => ({ causeId: s.cause.id, likelihood: s.likelihood })),
        },
      });
      if (!cust.id) cust.id = (await db.complaints.get(id))!.customerId;

      const stage = plan.stage;
      if (stage === 'Registered') continue;

      const isAc = ['Residential AC', 'Commercial AC', 'VRF / VRV'].includes(eq.category);
      const isGasJob = !!sc.gasShare;
      // A technician from the customer's branch: AC work to the AC team, the rest to the appliance technician.
      const local = techs.filter((t) => t.branch === cust.branch);
      const pool = local.filter((t) => t.ac === isAc);
      const tech = pick(pool.length ? pool : local.length ? local : techs);
      at(created + between(0.3, 3) * HOUR);
      await assignTechnician(db, settings, id, tech.id);
      // Book the visit: next day for jobs not yet started (older ones end up missed).
      const visitAt = new Date(created + (stage === 'Assigned' ? DAY : between(4, 30) * HOUR));
      const slot = visitAt.getHours() < 12 ? VISIT_SLOTS[0] : visitAt.getHours() < 16 ? VISIT_SLOTS[1] : VISIT_SLOTS[2];
      await scheduleVisit(db, settings, id, { date: localDay(visitAt), slot });
      if (r() < 0.6) await logCustomerContact(db, settings, id, 'Visit confirmed', pick(['Customer will be home after 2 pm.', 'Estate gate security informed.', 'Visit agreed for tomorrow morning.']));
      if (stage === 'Assigned') continue;

      const workStart = created + between(4, 30) * HOUR;
      at(workStart);
      await setStatus(db, settings, id, 'In Progress', 'Technician on site');

      const method: BrazingMethod = pick(['Oxy-Acetylene', 'Oxy-Acetylene', 'LPG / Butane', 'MAPP'] as const);
      const joints = sc.joints ? whole(...sc.joints) : 0;
      const job = {
        jobType: sc.job,
        pipeLengthM: sc.pipeM ? Number(between(...sc.pipeM).toFixed(1)) : undefined,
        brazedJoints: joints || undefined,
        brazingMethod: joints ? method : undefined,
        nitrogenPurged: joints ? (sc.purge ?? false) && r() < 0.85 : undefined,
        pressureTested: sc.pressureTest,
        flushedPipeM: sc.flushM,
        recoveredG: sc.recoveredG,
      };
      await updateJobDetails(db, settings, id, job);
      const c = (await db.complaints.get(id)) as Complaint;

      // Gas and spares, as the store would issue them.
      const techGas = tech.gas;
      const issue = async (item: InventoryItem | undefined, qty: number, overReason: string) => {
        if (!item || !(qty > 0)) return;
        qty = Number(qty.toFixed(item.unit === 'pcs' ? 0 : 3));
        const inStock = (await db.items.get(item.id))?.stock ?? 0;
        if (qty <= 0 || qty > inStock) return;
        const check = await checkIssue(db, settings, c, item.id, qty);
        await issueToComplaint(db, settings, id, item.id, qty, check.overLimit ? overReason : undefined);
      };
      if (isGasJob && eq.refrigerant) {
        const ref = gasFor((i) => i.type === 'Refrigerant' && i.refrigerant === eq.refrigerant);
        const plan = ref && issuePlan(ref, c, settings.norms);
        // One job in eight goes badly over, with the wrong kind of excuse.
        const blowout = r() < 0.12 ? between(1.4, 1.8) : 1;
        const qty = plan ? Number((plan.expected * between(...sc.gasShare!) * techGas * blowout).toFixed(2)) : 0;
        // Lagos jobs take a tagged cylinder and weigh it out and back in.
        const cyl =
          ref && cust.branch === branches[0]
            ? (await db.cylinders.bulkGet(cylinderIds)).find((x) => x && x.itemId === ref.id && x.status === 'In store')
            : undefined;
        if (cyl && qty > 0) {
          if (contentAt(cyl, cyl.lastReading) < qty + 0.5) {
            // Refill to a full cylinder (or enough for a big job such as a VRF recharge).
            at(workStart - HOUR);
            await refillCylinder(db, settings, cyl.id, Number((cyl.tareKg! + Math.max(10, qty + 2)).toFixed(2)), 'Demo refill');
          }
          const fresh = (await db.cylinders.get(cyl.id))!;
          // Once, the cylinder weighs less than it did in the store: a leak or unbooked use.
          const reading = !lossShown && r() < 0.3 ? ((lossShown = true), Number((fresh.lastReading - 0.35).toFixed(2))) : fresh.lastReading;
          at(workStart);
          await weighOut(db, settings, { cylinderId: cyl.id, reading, complaintId: id });
          // Once, a cylinder stays out with the technician (overdue).
          if (stage === 'In Progress' && !overdueShown) {
            overdueShown = true;
          } else {
            at(workStart + between(3, 8) * HOUR);
            await weighIn(db, settings, { cylinderId: cyl.id, reading: Number((reading - qty).toFixed(2)) });
          }
        } else if (plan) {
          await issue(ref, qty, pick(['Leak not found first time, recharged twice', 'Cylinder valve leaking, lost gas', 'Long pipe run on site']));
        }
      }
      if (joints) {
        const fuel = gasFor((i) => i.type === 'Brazing Gas' && i.brazingMethod === method && i.sku !== 'GAS-O2');
        const oxygen = method === 'Oxy-Acetylene' ? gasFor((i) => i.sku === 'GAS-O2') : undefined;
        for (const g of [fuel, oxygen]) {
          const p = g && issuePlan(g, c, settings.norms);
          if (p) await issue(g, p.expected * between(0.9, 1.25) * (techGas > 1.1 ? 1.3 : 1), 'Torch tip worn, used extra gas');
        }
        await issue(gasFor((i) => i.sku === 'CON-ROD-15'), Math.ceil(joints / 2), 'Extra joints');
      }
      if (job.nitrogenPurged || sc.pressureTest || sc.flushM) {
        const n2 = gasFor((i) => i.type === 'Nitrogen');
        const p = n2 && issuePlan(n2, c, settings.norms);
        if (p) await issue(n2, p.expected * between(0.9, 1.15), 'Second pressure test after repair');
      }
      if (sc.flushM) {
        const f = gasFor((i) => i.type === 'Flushing Agent');
        const p = f && issuePlan(f, c, settings.norms);
        if (p) await issue(f, p.expected, 'Heavy contamination');
      }
      // Branches get spares from the Lagos store through a request.
      let partsArrive = workStart;
      for (const sku of sc.spares ?? []) {
        const part = bySku.get(sku);
        if (!part) continue;
        if (cust.branch === branches[0]) {
          await issue(part, 1, 'Replacement part');
          continue;
        }
        at(workStart + HOUR);
        const reqId = await createRequest(db, settings, { branch: cust.branch, complaintId: id, lines: [{ itemId: part.id, qty: 1 }], reason: 'Faulty part found on site' });
        at(workStart + between(2, 5) * HOUR);
        await decideRequest(db, settings, reqId, true);
        if (stage === 'Awaiting Parts' && r() < 0.5) continue; // approved, not yet sent
        at(workStart + between(6, 10) * HOUR);
        await dispatchRequest(db, settings, reqId, { waybill: `GIGL-${whole(100000, 999999)}`, carrier: 'GIG Logistics' });
        if (stage === 'Awaiting Parts') continue; // in transit
        partsArrive = workStart + between(20, 40) * HOUR;
        at(partsArrive);
        await receiveRequest(db, settings, reqId, 'Received in good condition');
      }
      // Now and then refrigerant goes out on a job that shouldn't need any.
      if (!isGasJob && isAc && r() < 0.15 && eq.refrigerant) {
        await issue(gasFor((i) => i.type === 'Refrigerant' && i.refrigerant === eq.refrigerant), between(0.3, 0.6), 'Technician asked for gas "just in case"');
      }

      if (stage === 'In Progress') continue;
      if (stage === 'Awaiting Parts') {
        const now = (await db.complaints.get(id))!;
        if (now.status !== 'Awaiting Parts') {
          at(workStart + 2 * HOUR);
          await setStatus(db, settings, id, 'Awaiting Parts', 'Part ordered from supplier');
        }
        continue;
      }

      const done = Math.max(workStart + between(1, sc.priority === 'Critical' ? 10 : 60) * HOUR, partsArrive + between(2, 8) * HOUR);
      at(done);
      await updateJobDetails(db, settings, id, {
        confirmedCauseId: r() < 0.85 ? sc.cause : undefined,
        rootCause: sc.resolution.split('.')[0] + '.',
        resolution: sc.resolution,
        serviceCharge: eq.warranty === 'In Warranty' ? 0 : Math.round(between(...(sc.charge ?? [5000, 15000])) / 500) * 500,
      });
      await setStatus(db, settings, id, 'Resolved');
      if (stage === 'Resolved') continue;

      at(done + between(2, 30) * HOUR);
      const rating = (r() < 0.7 ? 5 : r() < 0.7 ? 4 : r() < 0.6 ? 3 : 2) as 2 | 3 | 4 | 5;
      await updateJobDetails(db, settings, id, { customerFeedback: rating });
      await logCustomerContact(
        db,
        settings,
        id,
        rating >= 4 ? 'Customer satisfied' : 'Customer not satisfied',
        rating >= 4 ? pick(['Working well now, thank you.', 'Very happy with the technician.', 'All good.']) : pick(['Took too long to come.', 'Still a bit noisy.']),
      );
      await setStatus(db, settings, id, 'Closed');
    }

    // The Service Head has already reviewed some of the older alerts.
    const alerts = await db.alerts.where('id').startsWith(DEMO_PREFIX).toArray();
    for (const a of alerts) {
      if (a.cleared || a.acknowledged || a.severity === 'info') continue;
      if (Date.parse(a.at) < Date.now() - 25 * DAY && r() < 0.5) {
        at(Date.parse(a.at) + 2 * DAY);
        await acknowledgeAlert(db, settings, a.id, pick(['Discussed with technician, charging by weight from now on.', 'Verified long pipe run on site.', 'Gas recovered and returned to store.']));
      }
    }
  } finally {
    runtime.now = prevNow;
    runtime.idPrefix = prevPrefix;
  }
}

/** Removes all demo records from this device (the server side is removed separately). */
export async function purgeLocalDemo(db: ServiceDB) {
  await db.applyRemote([...SYNCED_TABLES], async () => {
    const touched = new Set<string>();
    for (const m of await db.movements.where('id').startsWith(DEMO_PREFIX).toArray()) touched.add(m.itemId);
    for (const t of SYNCED_TABLES) {
      if (t === 'settings' || t === 'items') continue;
      await db.table(t).where('id').startsWith(DEMO_PREFIX).delete();
    }
    await recomputeStock(db, touched);
  });
}
