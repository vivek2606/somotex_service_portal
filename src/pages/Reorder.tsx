import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtMoney, fmtNum, Loading } from '../components/ui';
import { db } from '../db/db';
import { downloadText, toCsv } from '../lib/csv';

/** Days of stock the suggested order aims to cover. */
const TARGET_DAYS = 60;

export default function Reorder() {
  const settings = useSettings();
  const rows = useLiveQuery(async () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const used = new Map<string, number>();
    await db.movements
      .where('at')
      .aboveOrEqual(since)
      .each((m) => {
        if ((m.kind === 'Issue' || m.kind === 'Return') && m._dirty !== 2) used.set(m.itemId, (used.get(m.itemId) ?? 0) - m.qty);
      });
    const items = await db.items.filter((i) => i.active).toArray();
    return items
      .map((i) => {
        const perDay = Math.max(0, used.get(i.id) ?? 0) / 30;
        const cover = perDay > 0 ? i.stock / perDay : undefined;
        const target = Math.max(i.reorderLevel * 2, perDay * TARGET_DAYS);
        const suggest = Math.max(0, Math.ceil(target - i.stock));
        const due = i.stock <= i.reorderLevel || (cover !== undefined && cover < 30);
        return { item: i, perDay, cover, suggest, due };
      })
      .filter((r) => r.due && r.suggest > 0)
      .sort((a, b) => (a.cover ?? Infinity) - (b.cover ?? Infinity));
  }, []);

  if (!rows) return <Loading />;
  const total = rows.reduce((t, r) => t + r.suggest * r.item.unitCost, 0);

  const exportCsv = () =>
    downloadText(
      `reorder-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv([
        ['SKU', 'Item', 'Type', 'Unit', 'In stock', 'Reorder level', 'Used per day (30d avg)', 'Days of cover', 'Suggested order', 'Unit cost', 'Line value'],
        ...rows.map((r) => [
          r.item.sku, r.item.name, r.item.type, r.item.unit, r.item.stock, r.item.reorderLevel, r.perDay.toFixed(3),
          r.cover !== undefined ? Math.floor(r.cover) : '', r.suggest, r.item.unitCost, r.suggest * r.item.unitCost,
        ]),
      ]),
    );

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Reorder list</h1>
          <div className="small muted">
            Items at or below their reorder level, or with less than 30 days of stock at the current rate of use. Suggested
            quantities cover about {TARGET_DAYS} days.
          </div>
        </div>
        <span className="spacer" />
        <button onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
        <button onClick={() => window.print()} disabled={!rows.length}>
          Print
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="card">
          <Empty>Nothing needs ordering right now.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">In stock</th>
                  <th className="num hide-mobile">Use / day</th>
                  <th className="num">Days left</th>
                  <th className="num">Order</th>
                  <th className="num hide-mobile">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.item.id}>
                    <td>
                      <Link to={`/inventory/${r.item.id}`}>{r.item.name}</Link>
                      <div className="small muted">
                        {r.item.sku} · {r.item.type}
                      </div>
                    </td>
                    <td className="num" style={{ color: r.item.stock <= 0 ? 'var(--bad)' : undefined }}>
                      {fmtNum(r.item.stock, 3)} {r.item.unit}
                    </td>
                    <td className="num hide-mobile">{r.perDay ? fmtNum(r.perDay, 3) : '—'}</td>
                    <td className="num">{r.cover !== undefined ? Math.floor(r.cover) : '—'}</td>
                    <td className="num">
                      <strong>
                        {fmtNum(r.suggest)} {r.item.unit}
                      </strong>
                    </td>
                    <td className="num hide-mobile">{fmtNum(r.suggest * r.item.unitCost, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ padding: 12 }}>
            Estimated order value {fmtMoney(total, settings.currency)} (at recorded unit costs)
          </div>
        </div>
      )}
    </div>
  );
}
