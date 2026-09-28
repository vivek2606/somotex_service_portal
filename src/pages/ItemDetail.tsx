import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ItemForm } from '../components/ItemForm';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, fmtMoney, fmtNum, Loading, useAction } from '../components/ui';
import { db } from '../db/db';
import { adjustStock, receiveStock } from '../db/service';

export default function ItemDetail() {
  const id = useParams().id ?? '';
  const settings = useSettings();
  const item = useLiveQuery(() => db.items.get(id), [id]);
  const moves = useLiveQuery(() => db.movements.where('itemId').equals(id).reverse().sortBy('at'), [id]);
  const complaints = useLiveQuery(async () => {
    const ids = [...new Set((moves ?? []).map((m) => m.complaintId).filter((x): x is string => x !== undefined))];
    return new Map((await db.complaints.bulkGet(ids)).filter(Boolean).map((c) => [c!.id, c!.ticketNo]));
  }, [moves]);
  const technicians = useLiveQuery(async () => new Map((await db.technicians.toArray()).map((t) => [t.id, t.name])), []);
  const { run, busy } = useAction();
  const { can } = useAuth();
  const [recv, setRecv] = useState({ qty: '', ref: '', cost: '' });
  const [count, setCount] = useState({ qty: '', note: '' });
  const [editing, setEditing] = useState(false);

  if (!item) return <Loading />;

  const receive = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await receiveStock(db, settings, id, Number(recv.qty), recv.ref || undefined, recv.cost === '' ? undefined : Number(recv.cost));
      setRecv({ qty: '', ref: '', cost: '' });
    }, 'Stock received');
  };
  const adjust = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!count.note.trim()) throw new Error('Enter a reason for the adjustment');
      await adjustStock(db, settings, id, Number(count.qty), count.note.trim());
      setCount({ qty: '', note: '' });
    }, 'Stock adjusted');
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>{item.name}</h1>
          <div className="small muted">
            {item.sku} · {item.type}
            {item.refrigerant && <> · {item.refrigerant}</>}
            {item.location && <> · {item.location}</>}
          </div>
        </div>
        <span className="spacer" />
        {can('editItems') && <button onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit item'}</button>}
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className={`card kpi ${item.stock <= item.reorderLevel ? 'bad' : 'ok'}`}>
          <div className="label">In stock</div>
          <div className="value">
            {fmtNum(item.stock, 3)} <span className="small">{item.unit}</span>
          </div>
        </div>
        <div className="card kpi">
          <div className="label">Reorder level</div>
          <div className="value">{fmtNum(item.reorderLevel)}</div>
        </div>
        <div className="card kpi">
          <div className="label">Stock value</div>
          <div className="value" style={{ fontSize: '1.2rem' }}>
            {fmtMoney(item.stock * item.unitCost, settings.currency)}
          </div>
        </div>
      </div>

      {editing && (
        <div className="card" style={{ marginBottom: 14 }}>
          <ItemForm
            initial={item}
            busy={busy}
            submitLabel="Save item"
            onSubmit={(d) =>
              run(async () => {
                const clash = await db.items.where('sku').equals(d.sku).first();
                if (clash && clash.id !== id) throw new Error(`SKU ${d.sku} is used by ${clash.name}`);
                await db.items.update(id, d);
                setEditing(false);
              }, 'Item saved')
            }
          />
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={receive}>
          <h2>Receive stock</h2>
          <div className="form-grid">
            <label className="field">
              Quantity ({item.unit})
              <input type="number" min="0" step="any" required value={recv.qty} onChange={(e) => setRecv({ ...recv, qty: e.target.value })} />
            </label>
            <label className="field">
              GRN / invoice ref.
              <input value={recv.ref} onChange={(e) => setRecv({ ...recv, ref: e.target.value })} />
            </label>
            {can('editItems') && (
              <label className="field">
                Unit cost <span className="hint">optional, updates cost</span>
                <input type="number" min="0" step="any" value={recv.cost} onChange={(e) => setRecv({ ...recv, cost: e.target.value })} />
              </label>
            )}
          </div>
          <button className="primary" disabled={busy} style={{ marginTop: 12 }}>
            Receive
          </button>
        </form>
        {can('adjustStock') && (
        <form className="card" onSubmit={adjust}>
          <h2>Stock count / adjustment</h2>
          <div className="form-grid">
            <label className="field">
              Counted quantity ({item.unit})
              <input type="number" min="0" step="any" required value={count.qty} onChange={(e) => setCount({ ...count, qty: e.target.value })} />
            </label>
            <label className="field">
              Reason *
              <input value={count.note} onChange={(e) => setCount({ ...count, note: e.target.value })} placeholder="e.g. monthly count, cylinder weighed" />
            </label>
          </div>
          <button disabled={busy} style={{ marginTop: 12 }}>
            Save count
          </button>
        </form>
        )}
      </div>

      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>Stock ledger</h2>
        {!moves?.length ? (
          <Empty>No movements yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="num">Qty</th>
                  <th>Job / ref.</th>
                  <th className="hide-mobile">Technician</th>
                  <th className="hide-mobile">By</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap small">{fmtDateTime(m.at)}</td>
                    <td>{m.kind}</td>
                    <td className="num" style={{ color: m.qty < 0 ? 'var(--bad)' : 'var(--ok)' }}>
                      {m.qty > 0 ? '+' : ''}
                      {fmtNum(m.qty, 3)}
                    </td>
                    <td>
                      {m.complaintId ? <Link to={`/complaints/${m.complaintId}`}>{complaints?.get(m.complaintId) ?? m.reference}</Link> : m.reference}
                      {m.note && <div className="small muted">{m.note}</div>}
                    </td>
                    <td className="hide-mobile">{m.technicianId ? technicians?.get(m.technicianId) : ''}</td>
                    <td className="hide-mobile small">
                      {m.by}
                      {m.byEmail && <div className="muted">{m.byEmail}</div>}
                      {m._dirty === 2 && <div className="error">Refused by server: {m._syncError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
