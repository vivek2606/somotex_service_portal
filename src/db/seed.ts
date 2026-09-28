import { newId, type ServiceDB } from './db';
import type { AppSettings } from './settings';
import { createComplaint, issueToComplaint, receiveStock, setStatus, updateJobDetails } from './service';
import type { InventoryItem } from './types';

type NewItem = Omit<InventoryItem, 'id' | 'stock' | 'active'>;

/** Starter items get fixed ids so every device seeds the same records. */
export const starterItemId = (sku: string) => `starter-${sku.toLowerCase()}`;

/** Starter catalogue of refrigerants, gases and common spares (zero stock). */
export const STARTER_ITEMS: NewItem[] = [
  { sku: 'REF-R22', name: 'Refrigerant R-22', type: 'Refrigerant', unit: 'kg', refrigerant: 'R22', reorderLevel: 10, unitCost: 0 },
  { sku: 'REF-R134A', name: 'Refrigerant R-134a', type: 'Refrigerant', unit: 'kg', refrigerant: 'R134a', reorderLevel: 5, unitCost: 0 },
  { sku: 'REF-R410A', name: 'Refrigerant R-410A', type: 'Refrigerant', unit: 'kg', refrigerant: 'R410A', reorderLevel: 20, unitCost: 0 },
  { sku: 'REF-R32', name: 'Refrigerant R-32', type: 'Refrigerant', unit: 'kg', refrigerant: 'R32', reorderLevel: 20, unitCost: 0 },
  { sku: 'REF-R600A', name: 'Refrigerant R-600a', type: 'Refrigerant', unit: 'kg', refrigerant: 'R600a', reorderLevel: 2, unitCost: 0 },
  { sku: 'REF-R290', name: 'Refrigerant R-290', type: 'Refrigerant', unit: 'kg', refrigerant: 'R290', reorderLevel: 2, unitCost: 0 },
  {
    sku: 'GAS-O2',
    name: 'Oxygen (oxy-acetylene brazing)',
    type: 'Brazing Gas',
    unit: 'm³',
    brazingMethod: 'Oxy-Acetylene',
    reorderLevel: 6,
    unitCost: 0,
    norm: { perJob: 0.05, perJoint: 0.02 },
  },
  {
    sku: 'GAS-C2H2',
    name: 'Acetylene (oxy-acetylene brazing)',
    type: 'Brazing Gas',
    unit: 'kg',
    brazingMethod: 'Oxy-Acetylene',
    reorderLevel: 4,
    unitCost: 0,
    norm: { perJob: 0.03, perJoint: 0.015 },
  },
  {
    sku: 'GAS-LPG',
    name: 'LPG / Butane (brazing torch)',
    type: 'Brazing Gas',
    unit: 'kg',
    brazingMethod: 'LPG / Butane',
    reorderLevel: 4,
    unitCost: 0,
    norm: { perJob: 0.03, perJoint: 0.025 },
  },
  {
    sku: 'GAS-MAPP',
    name: 'MAPP gas (brazing torch)',
    type: 'Brazing Gas',
    unit: 'kg',
    brazingMethod: 'MAPP',
    reorderLevel: 2,
    unitCost: 0,
    norm: { perJob: 0.02, perJoint: 0.02 },
  },
  {
    sku: 'GAS-N2',
    name: 'Dry nitrogen (purging, pressure test, flushing)',
    type: 'Nitrogen',
    unit: 'm³',
    reorderLevel: 6,
    unitCost: 0,
    norm: { perJob: 0.05, perJoint: 0.03, perFlushM: 0.03, perPressureTest: 0.3, perPressureTestKw: 0.05 },
  },
  {
    sku: 'FLUSH-AGENT',
    name: 'Circuit flushing solvent',
    type: 'Flushing Agent',
    unit: 'L',
    reorderLevel: 10,
    unitCost: 0,
    norm: { perJob: 0.2, perFlushM: 0.1 },
  },
  { sku: 'CON-ROD-15', name: 'Brazing rod 15% silver', type: 'Consumable', unit: 'pcs', reorderLevel: 50, unitCost: 0, norm: { perJoint: 0.5 } },
  { sku: 'CON-ROD-CU', name: 'Brazing rod copper-phos', type: 'Consumable', unit: 'pcs', reorderLevel: 50, unitCost: 0, norm: { perJoint: 0.5 } },
  { sku: 'CON-FLUX', name: 'Brazing flux', type: 'Consumable', unit: 'g', reorderLevel: 500, unitCost: 0 },
  { sku: 'CON-TAPE', name: 'PVC insulation tape', type: 'Consumable', unit: 'pcs', reorderLevel: 30, unitCost: 0 },
  { sku: 'CON-PIPE-14', name: 'Copper pipe 1/4"', type: 'Consumable', unit: 'm', reorderLevel: 50, unitCost: 0 },
  { sku: 'CON-PIPE-38', name: 'Copper pipe 3/8"', type: 'Consumable', unit: 'm', reorderLevel: 50, unitCost: 0 },
  { sku: 'CON-PIPE-12', name: 'Copper pipe 1/2"', type: 'Consumable', unit: 'm', reorderLevel: 50, unitCost: 0 },
  { sku: 'SP-CAP-35', name: 'Run capacitor 35 µF', type: 'Spare', unit: 'pcs', reorderLevel: 10, unitCost: 0, compatibility: 'Split AC outdoor units' },
  { sku: 'SP-CAP-FAN', name: 'Fan capacitor 2.5 µF', type: 'Spare', unit: 'pcs', reorderLevel: 10, unitCost: 0 },
  { sku: 'SP-FILTER-DRIER', name: 'Filter drier (fridge)', type: 'Spare', unit: 'pcs', reorderLevel: 10, unitCost: 0 },
  { sku: 'SP-THERMO-FR', name: 'Thermostat (fridge/freezer)', type: 'Spare', unit: 'pcs', reorderLevel: 5, unitCost: 0 },
  { sku: 'SP-WM-DRAIN', name: 'Washing machine drain pump', type: 'Spare', unit: 'pcs', reorderLevel: 3, unitCost: 0 },
  { sku: 'SP-MW-MAG', name: 'Microwave magnetron', type: 'Spare', unit: 'pcs', reorderLevel: 2, unitCost: 0 },
  { sku: 'SP-GC-IGN', name: 'Gas cooker ignition unit', type: 'Spare', unit: 'pcs', reorderLevel: 3, unitCost: 0 },
];

export async function seedIfEmpty(db: ServiceDB) {
  if ((await db.items.count()) > 0) return;
  await db.items.bulkAdd(STARTER_ITEMS.map((i) => ({ ...i, id: starterItemId(i.sku), stock: 0, active: true })));
}

/** Demo technicians, customers, stock and jobs so the team can explore. */
export async function loadDemoData(db: ServiceDB, settings: AppSettings) {
  await seedIfEmpty(db);
  const s = { ...settings, currentUser: 'Demo' };
  const [t1, t2] = [newId(), newId()];
  await db.technicians.bulkAdd([
    { id: t1, name: 'Chikondi Banda', phone: '0888 000 001', skills: 'AC, VRF, refrigeration', active: true },
    { id: t2, name: 'Mphatso Phiri', phone: '0999 000 002', skills: 'Fridges, washing machines, cookers', active: true },
  ]);

  const sku = async (code: string) => (await db.items.where('sku').equals(code).first())!.id;
  for (const [code, qty] of [
    ['REF-R32', 40],
    ['REF-R410A', 30],
    ['REF-R22', 8],
    ['REF-R600A', 3],
    ['GAS-O2', 10],
    ['GAS-C2H2', 6],
    ['GAS-LPG', 6],
    ['GAS-N2', 12],
    ['CON-ROD-15', 100],
    ['SP-CAP-35', 4],
  ] as const) {
    await receiveStock(db, s, await sku(code), qty, 'Opening stock');
  }

  const a = await createComplaint(db, s, {
    customer: { name: 'Lilongwe Grand Hotel', phone: '0111 222 333', address: 'Area 4, Lilongwe', city: 'Lilongwe', type: 'Business' },
    equipment: {
      brand: 'Midea',
      category: 'Residential AC',
      model: 'MSAFB-18CRN8',
      serialNo: 'MD18-000123',
      capacity: 18000,
      capacityUnit: 'BTU/h',
      refrigerant: 'R32',
      warranty: 'In Warranty',
    },
    complaintType: 'Not cooling / low cooling',
    description: 'Room 204 AC blowing warm air.',
    priority: 'High',
    source: 'Phone',
    technicianId: t1,
  });
  await updateJobDetails(db, s, a, {
    jobType: 'Gas Top-up',
    pressureTested: false,
    resolution: 'Found low pressure, topped up gas.',
    rootCause: 'Slow leak at flare nut',
  });
  // 18,000 BTU/h R32 ≈ 844 g nominal; a top-up of 1.2 kg is well above norm.
  await issueToComplaint(db, s, a, await sku('REF-R32'), 1.2, 'Technician requested extra for a long pipe run');
  await setStatus(db, s, a, 'Closed');

  const b = await createComplaint(db, s, {
    customer: { name: 'Grace Mwale', phone: '0888 123 456', address: 'Chilomoni, Blantyre', city: 'Blantyre', type: 'Individual' },
    equipment: {
      brand: 'Tamashi',
      category: 'Chest Freezer',
      model: 'TCF-300',
      serialNo: 'TM300-7781',
      capacity: 300,
      capacityUnit: 'L',
      refrigerant: 'R600a',
      warranty: 'In Warranty',
    },
    complaintType: 'Not cooling / low cooling',
    description: 'Freezer not freezing since last week.',
    priority: 'Normal',
    source: 'Walk-in',
    technicianId: t2,
  });
  await setStatus(db, s, b, 'In Progress', 'Technician on site');

  await createComplaint(db, s, {
    customer: { name: 'Kamuzu Traders', phone: '0999 765 432', address: 'Mzuzu Main Road', city: 'Mzuzu', type: 'Dealer' },
    equipment: {
      brand: 'Beko',
      category: 'Washing Machine',
      model: 'WTV8612',
      serialNo: 'BK-55120',
      warranty: 'Out of Warranty',
    },
    complaintType: 'Not spinning / draining',
    description: 'Water stays in drum after cycle.',
    priority: 'Normal',
    source: 'Dealer',
  });
}
