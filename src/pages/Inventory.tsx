import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { blankItem, ItemForm } from '../components/ItemForm';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtMoney, fmtNum, Loading, useAction } from '../components/ui';
import { db, newId } from '../db/db';
import type { ItemType } from '../db/types';
import { downloadText, toCsv } from '../lib/csv';

const TYPES: ItemType[] = ['Spare', 'Refrigerant', 'Brazing Gas', 'Nitrogen', 'Flushing Agent', 'Consumable'];

export default function Inventory() {
  const settings = useSettings();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const type = params.get('type') ?? '';
  const lowOnly = params.get('low') === '1';
  const [adding, setAdding] = useState(false);
  const { run, busy } = useAction();
  const { can } = useAuth();

  const data = useLiveQuery(async () => {
    const items = await db.items.orderBy('name').toArray();
    // 30-day usage for days-of-cover.
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const moves = await db.movements.where('at').aboveOrEqual(since).toArray();
    const used = new Map<string, number>();
    for (const m of moves) if (m.kind === 'Issue' || m.kind === 'Return') used.set(m.itemId, (used.get(m.itemId) ?? 0) - m.qty);
    return { items, used };
  }, []);

  const list = useMemo(() => {
    if (!data) return undefined;
    return data.items.filter((i) => {
      if (type && i.type !== type) return false;
      if (lowOnly && i.stock > i.reorderLevel) return false;
      if (!query) return true;
      return [i.sku, i.name, i.compatibility, i.location].filter(Boolean).some((v) => v!.toLowerCase().includes(query));
    });
  }, [data, type, lowOnly, query]);

  const value = list?.reduce((t, i) => t + i.stock * i.unitCost, 0) ?? 0;
  const setFilter = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };

  const exportCsv = () => {
    if (!list) return;
    downloadText(
      `stock-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv([
        ['SKU', 'Name', 'Type', 'Unit', 'Stock', 'Reorder Level', 'Unit Cost', 'Value', 'Used 30d', 'Compatibility', 'Location'],
        ...list.map((i) => [
          i.sku, i.name, i.type, i.unit, i.stock, i.reorderLevel, i.unitCost, i.stock * i.unitCost,
          data!.used.get(i.id) ?? 0, i.compatibility, i.location,
        ]),
      ]),
    );
  };

  return (
    <div>
      <div className="topbar">
        <h1>Inventory</h1>
        <span className="spacer" />
        <button onClick={exportCsv}>Export CSV</button>
        <Link to="/inventory/reorder" className="btn">
          Reorder list
        </Link>
        {can('importStock') && (
          <Link to="/inventory/import" className="btn">
            Import stock sheet
          </Link>
        )}
        {can('editItems') && (
          <button className="primary" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add item'}
          </button>
        )}
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>New item</h2>
          <ItemForm
            initial={blankItem}
            busy={busy}
            submitLabel="Create item"
            onSubmit={(d) =>
              run(async () => {
                if (await db.items.where('sku').equals(d.sku).count()) throw new Error(`SKU ${d.sku} already exists`);
                const id = newId();
                await db.items.add({ ...d, id, stock: 0 });
                navigate(`/inventory/${id}`);
              }, 'Item created. Receive stock on the next screen.')
            }
          />
        </div>
      )}

      <div className="filters">
        <input type="search" placeholder="Search SKU, name, model, bin…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={type} onChange={(e) => setFilter('type', e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <label className="field inline" style={{ flex: '0 0 auto' }}>
          <input type="checkbox" checked={lowOnly} onChange={(e) => setFilter('low', e.target.checked ? '1' : '')} />
          Low stock only
        </label>
      </div>

      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty>No items match.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="hide-mobile">Type</th>
                  <th className="num">Stock</th>
                  <th className="num hide-mobile">Used 30d</th>
                  <th className="num hide-mobile">Days cover</th>
                  <th className="num hide-mobile">Value</th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => {
                  const used = data!.used.get(i.id) ?? 0;
                  const cover = used > 0 ? (i.stock / used) * 30 : undefined;
                  const low = i.stock <= i.reorderLevel;
                  return (
                    <tr key={i.id} className="clickable" onClick={() => navigate(`/inventory/${i.id}`)} style={{ opacity: i.active ? 1 : 0.5 }}>
                      <td>
                        <Link to={`/inventory/${i.id}`}>{i.name}</Link>
                        <div className="small muted">
                          {i.sku}
                          {i.location && <> · {i.location}</>}
                        </div>
                      </td>
                      <td className="hide-mobile">{i.type}</td>
                      <td className="num">
                        <strong style={{ color: i.stock <= 0 ? 'var(--bad)' : low ? 'var(--warn)' : undefined }}>{fmtNum(i.stock, 3)}</strong> {i.unit}
                        {low && (
                          <div>
                            <span className={`badge ${i.stock <= 0 ? 'bad' : 'warn'}`}>{i.stock <= 0 ? 'Out' : 'Reorder'}</span>
                          </div>
                        )}
                      </td>
                      <td className="num hide-mobile">{used ? fmtNum(used, 3) : '—'}</td>
                      <td className="num hide-mobile">{cover !== undefined ? `${Math.round(cover)} d` : '—'}</td>
                      <td className="num hide-mobile">{fmtNum(i.stock * i.unitCost, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ padding: 12 }}>
            {list.length} items · stock value {fmtMoney(value, settings.currency)}
          </div>
        </div>
      )}
    </div>
  );
}
