import { DEFAULT_NORMS, type ConsumptionNorms } from '../lib/consumption';
import { DEFAULT_WARRANTY_RULES, type WarrantyRule } from '../lib/warranty';
import type { Priority, ProductCategory } from './types';
import type { ServiceDB } from './db';

export interface Brand {
  name: string;
  /** In-house brands are assembled locally (e.g. Tamashi, Bruhm). */
  inHouse: boolean;
}

export interface AppSettings {
  companyName: string;
  /** Signed-in person (set from the login, not stored). */
  currentUser: string;
  currentUserEmail?: string;
  currency: string;
  /** Dialling code used for WhatsApp/SMS links, e.g. 234 for Nigeria. */
  countryCode: string;
  ticketPrefix: string;
  /** Service locations; complaints and technicians belong to one. */
  branches: string[];
  brands: Brand[];
  categories: ProductCategory[];
  complaintTypes: string[];
  /** SLA target resolution time in hours, by priority. */
  slaHours: Record<Priority, number>;
  norms: ConsumptionNorms;
  /** Warranty periods by brand and product, from the invoice date. */
  warrantyRules: WarrantyRule[];
  /** Set by the server when demo data is removed, so every device drops its copy. */
  demoPurgedAt?: string;
}

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  'Residential AC',
  'Commercial AC',
  'VRF / VRV',
  'Chiller',
  'Refrigerator',
  'Chest Freezer',
  'Washing Machine',
  'Television',
  'Gas Cooker',
  'Microwave',
  'Other',
];

export const DEFAULT_SETTINGS: AppSettings = {
  companyName: 'Somotex',
  currentUser: 'Service Desk',
  currency: 'NGN',
  countryCode: '234',
  branches: ['Lagos (Head Office)', 'Abuja', 'Ibadan', 'Onitsha', 'Port Harcourt', 'Kano'],
  ticketPrefix: 'SMX',
  brands: [
    { name: 'Midea', inHouse: false },
    { name: 'Tamashi', inHouse: true },
    { name: 'Bruhm', inHouse: true },
    { name: 'Sharp', inHouse: false },
    { name: 'Beko', inHouse: false },
    { name: 'AUX', inHouse: false },
    { name: 'Chigo', inHouse: false },
    { name: 'Other', inHouse: false },
  ],
  categories: PRODUCT_CATEGORIES,
  complaintTypes: [
    'Not cooling / low cooling',
    'Not powering on',
    'Water leakage',
    'Gas leakage',
    'Noise / vibration',
    'Error code on display',
    'Not spinning / draining',
    'No picture / no sound',
    'Burner / ignition fault',
    'Not heating',
    'Door / seal / physical damage',
    'Installation request',
    'Preventive maintenance',
    'Other',
  ],
  slaHours: { Critical: 24, High: 48, Normal: 72, Low: 120 },
  norms: DEFAULT_NORMS,
  warrantyRules: DEFAULT_WARRANTY_RULES,
};

const KEY = 'app';

export async function loadSettings(db: ServiceDB): Promise<AppSettings> {
  const row = await db.settings.get(KEY);
  const saved = (row?.value ?? {}) as Partial<AppSettings>;
  return mergeSettings(saved);
}

/** Fills in any fields added in newer versions so old saves keep working. */
export function mergeSettings(saved: Partial<AppSettings>): AppSettings {
  const norms = saved.norms ?? DEFAULT_NORMS;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    slaHours: { ...DEFAULT_SETTINGS.slaHours, ...saved.slaHours },
    // There is always a general rule to fall back on.
    warrantyRules: saved.warrantyRules?.some((r) => r.brand === 'Any' && r.category === 'Any')
      ? saved.warrantyRules
      : [...DEFAULT_WARRANTY_RULES, ...(saved.warrantyRules ?? [])],
    norms: {
      ...DEFAULT_NORMS,
      ...norms,
      refrigerants: { ...DEFAULT_NORMS.refrigerants, ...norms.refrigerants },
      jobs: { ...DEFAULT_NORMS.jobs, ...norms.jobs },
    },
  };
}

export async function saveSettings(db: ServiceDB, s: AppSettings): Promise<void> {
  // The signed-in user's name is per session, not a shared setting.
  const { currentUser: _user, currentUserEmail: _email, ...shared } = s;
  void _user;
  void _email;
  await db.settings.put({ id: KEY, value: shared });
}
