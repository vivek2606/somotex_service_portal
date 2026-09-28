import type { ServiceDB } from './db';
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
