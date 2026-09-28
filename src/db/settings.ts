import { DEFAULT_NORMS, type ConsumptionNorms } from '../lib/consumption';
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
  /** Dialling code used for WhatsApp/SMS links, e.g. 265 for Malawi. */
  countryCode: string;
  ticketPrefix: string;
  brands: Brand[];
  categories: ProductCategory[];
  complaintTypes: string[];
  /** SLA target resolution time in hours, by priority. */
  slaHours: Record<Priority, number>;
  norms: ConsumptionNorms;
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
  currency: 'MWK',
  countryCode: '265',
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
