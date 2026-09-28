// Minimal CSV reading/writing plus mapping of stock sheets onto inventory items.

import type { BrazingMethod, ItemType, Refrigerant } from '../db/types';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  // Excel in some locales exports with semicolons.
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function toCsv(rows: (string | number | undefined | null)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === undefined || v === null ? '' : String(v);
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const HEADERS: Record<string, keyof StockRow> = {
  sku: 'sku',
  code: 'sku',
  'item code': 'sku',
  'part no': 'sku',
  'part number': 'sku',
  'part no.': 'sku',
  name: 'name',
  item: 'name',
  description: 'name',
  'item name': 'name',
  'part name': 'name',
  type: 'type',
  category: 'type',
  unit: 'unit',
  uom: 'unit',
  units: 'unit',
  stock: 'stock',
  qty: 'stock',
  quantity: 'stock',
  'stock qty': 'stock',
  balance: 'stock',
  'closing stock': 'stock',
  'reorder level': 'reorderLevel',
  reorder: 'reorderLevel',
  'min stock': 'reorderLevel',
  minimum: 'reorderLevel',
  cost: 'unitCost',
  'unit cost': 'unitCost',
  price: 'unitCost',
  rate: 'unitCost',
  compatibility: 'compatibility',
  model: 'compatibility',
  models: 'compatibility',
  'fits models': 'compatibility',
  brand: 'compatibility',
  location: 'location',
  bin: 'location',
  refrigerant: 'refrigerant',
  gas: 'refrigerant',
};

export interface StockRow {
  sku: string;
  name: string;
  type: ItemType;
  unit: string;
  stock?: number;
  reorderLevel?: number;
  unitCost?: number;
  compatibility?: string;
  location?: string;
  refrigerant?: Refrigerant;
  brazingMethod?: BrazingMethod;
}

const REFRIGERANTS: Refrigerant[] = ['R410A', 'R407C', 'R134a', 'R600a', 'R290', 'R32', 'R22'];

function detectRefrigerant(text: string): Refrigerant | undefined {
  const t = text.toUpperCase().replace(/[\s-]/g, '');
  const found = REFRIGERANTS.find((r) => t.includes(r.toUpperCase()));
  // "R600" on its own is taken to mean R600a, which is what the team uses.
  return found ?? (t.includes('R600') ? 'R600a' : undefined);
}

function inferType(name: string, given?: string): ItemType {
  const g = (given ?? '').toLowerCase();
  if (g.startsWith('refrig') || (g === 'gas' && detectRefrigerant(name))) return 'Refrigerant';
  if (g.includes('brazing')) return 'Brazing Gas';
  if (g.includes('nitrogen')) return 'Nitrogen';
  if (g.includes('flush')) return 'Flushing Agent';
  if (g.includes('consum')) return 'Consumable';
  if (g.includes('spare') || g.includes('part')) return 'Spare';
  const n = name.toLowerCase();
  if (detectRefrigerant(name) && !/capacitor|valve|compressor/.test(n)) return 'Refrigerant';
  if (/nitrogen|\bn2\b/.test(n)) return 'Nitrogen';
  if (/flush|r141b/.test(n)) return 'Flushing Agent';
  if (/oxygen|acetylene|\blpg\b|butane|mapp|propane/.test(n)) return 'Brazing Gas';
  if (/rod|flux|tape|pipe|insulation|wire|cable|bolt|screw|drain hose/.test(n)) return 'Consumable';
  return 'Spare';
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const cleaned = v.replace(/[^\d.-]/g, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export interface ParsedStockSheet {
  rows: StockRow[];
  errors: string[];
  unmappedColumns: string[];
}

/** Maps a stock sheet (CSV rows incl. header) onto inventory rows. */
export function mapStockSheet(table: string[][]): ParsedStockSheet {
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ['The file has no data rows'], unmappedColumns: [] };
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const cols = header.map((h) => HEADERS[h]);
  const unmappedColumns = table[0].filter((_, i) => !cols[i]);
  if (!cols.includes('name') && !cols.includes('sku')) {
    return { rows: [], errors: ['Need at least a "Name" or "SKU" column'], unmappedColumns };
  }
  const rows: StockRow[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((r, idx) => {
    const rec: Partial<Record<keyof StockRow, string>> = {};
    cols.forEach((c, i) => {
      if (c && r[i] !== undefined && rec[c] === undefined) rec[c] = r[i].trim();
    });
    const name = rec.name || rec.sku || '';
    if (!name) {
      errors.push(`Row ${idx + 2}: no name or SKU, skipped`);
      return;
    }
    const sku = (rec.sku || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (seen.has(sku)) {
      errors.push(`Row ${idx + 2}: duplicate SKU ${sku}, skipped`);
      return;
    }
    seen.add(sku);
    const type = inferType(name, rec.type);
    const refrigerant = type === 'Refrigerant' ? detectRefrigerant(rec.refrigerant || name) : undefined;
    const brazingMethod: BrazingMethod | undefined =
      type !== 'Brazing Gas'
        ? undefined
        : /mapp/i.test(name)
          ? 'MAPP'
          : /lpg|butane|propane/i.test(name)
            ? 'LPG / Butane'
            : /oxy|acetylene/i.test(name)
              ? 'Oxy-Acetylene'
              : undefined;
    let unit = (rec.unit || '').trim();
    if (!unit) unit = type === 'Refrigerant' ? 'kg' : type === 'Spare' ? 'pcs' : type === 'Nitrogen' ? 'm³' : 'pcs';
    const unitLc = unit.toLowerCase();
    if (unitLc === 'kgs' || unitLc === 'kilogram' || unitLc === 'kilograms') unit = 'kg';
    if (unitLc === 'nos' || unitLc === 'no' || unitLc === 'pc' || unitLc === 'each' || unitLc === 'ea') unit = 'pcs';
    const stock = num(rec.stock);
    if (rec.stock && stock === undefined) errors.push(`Row ${idx + 2}: stock "${rec.stock}" isn't a number, so it was left blank`);
    rows.push({
      sku,
      name,
      type,
      unit,
      stock,
      reorderLevel: num(rec.reorderLevel),
      unitCost: num(rec.unitCost),
      compatibility: rec.compatibility || undefined,
      location: rec.location || undefined,
      refrigerant,
      brazingMethod,
    });
  });
  return { rows, errors, unmappedColumns };
}

export const STOCK_TEMPLATE = toCsv([
  ['SKU', 'Name', 'Type', 'Unit', 'Stock', 'Reorder Level', 'Unit Cost', 'Compatibility', 'Location'],
  ['REF-R32', 'Refrigerant R32', 'Refrigerant', 'kg', 40, 20, '', '', 'Gas store'],
  ['GAS-O2', 'Oxygen (oxy-acetylene)', 'Brazing Gas', 'm³', 10, 6, '', '', 'Gas store'],
  ['GAS-LPG', 'LPG / Butane (brazing torch)', 'Brazing Gas', 'kg', 6, 4, '', '', 'Gas store'],
  ['SP-CAP-35', 'Run capacitor 35 µF', 'Spare', 'pcs', 12, 10, '', 'Midea / Tamashi split AC', 'Rack A1'],
]);
