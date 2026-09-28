import { useState, type FormEvent } from 'react';
import { BRAZING_METHODS, REFRIGERANTS as REFS, type BrazingMethod, type InventoryItem, type ItemNorm, type ItemType, type Refrigerant } from '../db/types';

const TYPES: ItemType[] = ['Spare', 'Refrigerant', 'Brazing Gas', 'Nitrogen', 'Flushing Agent', 'Consumable'];

export type ItemDraft = Omit<InventoryItem, 'id' | 'stock'>;

export const blankItem: ItemDraft = {
  sku: '',
  name: '',
  type: 'Spare',
  unit: 'pcs',
  reorderLevel: 0,
  unitCost: 0,
  active: true,
};

export function ItemForm({
  initial,
  onSubmit,
  busy,
  submitLabel,
}: {
  initial: ItemDraft;
  onSubmit: (d: ItemDraft) => void;
  busy: boolean;
  submitLabel: string;
}) {
  const [f, setF] = useState<ItemDraft>(initial);
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const setNorm = (k: keyof ItemNorm, v: string) => setF({ ...f, norm: { ...f.norm, [k]: num(v) } });
  const isGas = f.type !== 'Spare';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ ...f, sku: f.sku.trim().toUpperCase(), name: f.name.trim() });
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          SKU / part no. *
          <input value={f.sku} required onChange={(e) => setF({ ...f, sku: e.target.value })} />
        </label>
        <label className="field">
          Name *
          <input value={f.name} required onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          Type
          <select
            value={f.type}
            onChange={(e) => {
              const type = e.target.value as ItemType;
              setF({ ...f, type, unit: type === 'Refrigerant' ? 'kg' : f.unit });
            }}
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Unit
          {f.type === 'Refrigerant' ? (
            <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
              <option>kg</option>
              <option>g</option>
            </select>
          ) : (
            <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="pcs, kg, m³, L, m" />
          )}
        </label>
        {f.type === 'Refrigerant' && (
          <label className="field">
            Refrigerant
            <select value={f.refrigerant ?? ''} onChange={(e) => setF({ ...f, refrigerant: (e.target.value || undefined) as Refrigerant })}>
              <option value="">—</option>
              {REFS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        {f.type === 'Brazing Gas' && (
          <label className="field">
            Brazing method
            <select value={f.brazingMethod ?? ''} onChange={(e) => setF({ ...f, brazingMethod: (e.target.value || undefined) as BrazingMethod })}>
              <option value="">Any method</option>
              {BRAZING_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Reorder level
          <input type="number" min="0" step="any" value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: num(e.target.value) ?? 0 })} />
        </label>
        <label className="field">
          Unit cost
          <input type="number" min="0" step="any" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: num(e.target.value) ?? 0 })} />
        </label>
        <label className="field">
          Location / bin
          <input value={f.location ?? ''} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </label>
        <label className="field span-all">
          Fits brands / models
          <input value={f.compatibility ?? ''} onChange={(e) => setF({ ...f, compatibility: e.target.value })} />
        </label>
        {isGas && f.type !== 'Refrigerant' && (
          <fieldset className="span-all">
            <legend>Usage norm ({f.unit} per activity)</legend>
            <p className="hint" style={{ marginTop: 0 }}>
              Used to budget each job and flag over-use. Activity terms count only when that activity is recorded on the job; the
              per-job allowance is added on top.
            </p>
            <div className="form-grid">
              <label className="field">
                {f.type === 'Nitrogen' ? 'Per brazed joint (purge)' : 'Per brazed joint'}
                <input type="number" min="0" step="any" value={f.norm?.perJoint ?? ''} onChange={(e) => setNorm('perJoint', e.target.value)} />
              </label>
              <label className="field">
                Per metre flushed
                <input type="number" min="0" step="any" value={f.norm?.perFlushM ?? ''} onChange={(e) => setNorm('perFlushM', e.target.value)} />
              </label>
              <label className="field">
                Per pressure test
                <input type="number" min="0" step="any" value={f.norm?.perPressureTest ?? ''} onChange={(e) => setNorm('perPressureTest', e.target.value)} />
              </label>
              <label className="field">
                + per kW, per pressure test
                <input type="number" min="0" step="any" value={f.norm?.perPressureTestKw ?? ''} onChange={(e) => setNorm('perPressureTestKw', e.target.value)} />
              </label>
              <label className="field">
                Per-job allowance
                <input type="number" min="0" step="any" value={f.norm?.perJob ?? ''} onChange={(e) => setNorm('perJob', e.target.value)} />
              </label>
            </div>
          </fieldset>
        )}
        <label className="field inline">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          Active
        </label>
      </div>
      <button type="submit" className="primary" disabled={busy} style={{ marginTop: 12 }}>
        {submitLabel}
      </button>
    </form>
  );
}
