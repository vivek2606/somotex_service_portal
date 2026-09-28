// Warranty status from the invoice date and the warranty rules in Settings.

import type { Equipment, ProductCategory, WarrantyStatus } from '../db/types';

export const ANY = 'Any';

export interface WarrantyRule {
  /** Brand name, or "Any". */
  brand: string;
  /** Product category, or "Any". */
  category: ProductCategory | typeof ANY;
  /** General warranty (parts and labour) in months from the invoice date. */
  months: number;
  /** Longer compressor warranty in months, if the brand offers one. */
  compressorMonths?: number;
}

export const DEFAULT_WARRANTY_RULES: WarrantyRule[] = [{ brand: ANY, category: ANY, months: 12 }];

/** The most specific rule for a product: brand + category, then brand, then category, then the general rule. */
export function findRule(rules: WarrantyRule[], brand: string, category: ProductCategory): WarrantyRule | undefined {
  const score = (r: WarrantyRule) => {
    if (r.brand !== ANY && r.brand !== brand) return -1;
    if (r.category !== ANY && r.category !== category) return -1;
    return (r.brand !== ANY ? 2 : 0) + (r.category !== ANY ? 1 : 0);
  };
  let best: WarrantyRule | undefined;
  let bestScore = -1;
  for (const r of rules) {
    const s = score(r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

function addMonths(isoDate: string, months: number): Date {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // 31 Jan + 1 month → end of February, not early March.
  if (d.getDate() < day) d.setDate(0);
  // Covered up to and including the day before the anniversary.
  d.setDate(d.getDate() - 1);
  return d;
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface WarrantyResult {
  status: WarrantyStatus;
  /** Last day of the general warranty (YYYY-MM-DD). */
  until?: string;
  /** Last day of the compressor warranty, if longer. */
  compressorUntil?: string;
  compressorCovered?: boolean;
  months?: number;
  compressorMonths?: number;
}

/**
 * Works out the warranty on a given day (default today) from the invoice
 * date. Without an invoice date the status is Unknown.
 */
export function warrantyFor(
  eq: Pick<Equipment, 'brand' | 'category' | 'purchaseDate'>,
  rules: WarrantyRule[],
  on: Date = new Date(),
): WarrantyResult {
  if (!eq.purchaseDate) return { status: 'Unknown' };
  const rule = findRule(rules.length ? rules : DEFAULT_WARRANTY_RULES, eq.brand, eq.category);
  if (!rule) return { status: 'Unknown' };
  const today = isoDay(on);
  const until = isoDay(addMonths(eq.purchaseDate, rule.months));
  const result: WarrantyResult = {
    status: today <= until ? 'In Warranty' : 'Out of Warranty',
    until,
    months: rule.months,
  };
  if (rule.compressorMonths && rule.compressorMonths > rule.months) {
    result.compressorUntil = isoDay(addMonths(eq.purchaseDate, rule.compressorMonths));
    result.compressorMonths = rule.compressorMonths;
    result.compressorCovered = today <= result.compressorUntil;
  }
  return result;
}

/** Applies the computed warranty to the equipment record (keeps AMC contracts as they are). */
export function applyWarranty(eq: Equipment, rules: WarrantyRule[], on?: Date): Equipment {
  const w = warrantyFor(eq, rules, on);
  return {
    ...eq,
    warranty: eq.warranty === 'AMC' ? 'AMC' : w.status,
    warrantyUntil: w.until,
    compressorWarrantyUntil: w.compressorUntil,
  };
}
