import { describe, expect, it } from 'vitest';
import { applyWarranty, findRule, warrantyFor, type WarrantyRule } from '../lib/warranty';
import type { Equipment } from '../db/types';

const rules: WarrantyRule[] = [
  { brand: 'Any', category: 'Any', months: 12 },
  { brand: 'Midea', category: 'Any', months: 18 },
  { brand: 'Any', category: 'Residential AC', months: 12, compressorMonths: 36 },
  { brand: 'Tamashi', category: 'Refrigerator', months: 24 },
];
const eq = (brand: string, category: Equipment['category'], purchaseDate?: string): Equipment => ({
  brand, category, model: '', serialNo: '', purchaseDate, warranty: 'Unknown',
});

describe('warranty rules', () => {
  it('uses the most specific rule', () => {
    expect(findRule(rules, 'Tamashi', 'Refrigerator')!.months).toBe(24);
    expect(findRule(rules, 'Midea', 'Residential AC')!.months).toBe(18); // brand beats category
    expect(findRule(rules, 'Sharp', 'Residential AC')!.compressorMonths).toBe(36);
    expect(findRule(rules, 'Beko', 'Television')!.months).toBe(12);
  });

  it('covers up to the day before the anniversary', () => {
    const w = warrantyFor(eq('Beko', 'Television', '2025-03-15'), rules, new Date('2026-03-14T12:00:00'));
    expect(w).toMatchObject({ status: 'In Warranty', until: '2026-03-14', months: 12 });
    expect(warrantyFor(eq('Beko', 'Television', '2025-03-15'), rules, new Date('2026-03-15T09:00:00')).status).toBe('Out of Warranty');
  });

  it('handles month ends', () => {
    expect(warrantyFor(eq('Beko', 'Television', '2025-01-31'), [{ brand: 'Any', category: 'Any', months: 1 }], new Date('2025-02-01')).until).toBe('2025-02-27');
  });

  it('reports a longer compressor warranty separately', () => {
    const w = warrantyFor(eq('Sharp', 'Residential AC', '2024-06-01'), rules, new Date('2026-01-10'));
    expect(w.status).toBe('Out of Warranty');
    expect(w).toMatchObject({ compressorUntil: '2027-05-31', compressorCovered: true });
  });

  it('is unknown without an invoice date and keeps AMC contracts', () => {
    expect(warrantyFor(eq('Midea', 'Microwave'), rules).status).toBe('Unknown');
    const amc = applyWarranty({ ...eq('Midea', 'Commercial AC', '2020-01-01'), warranty: 'AMC' }, rules);
    expect(amc.warranty).toBe('AMC');
    expect(amc.warrantyUntil).toBe('2021-06-30');
  });
});
