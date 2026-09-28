import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, fmtDuration, fmtMoney, fmtNum, Loading, useAction, useToast } from '../components/ui';
import {
  contentAt,
  measureFor,
  OVERDUE_HOURS,
  readingUnit,
  refillCylinder,
  registerCylinder,
  retireCylinder,
  weighIn,
  weighOut,
} from '../db/cylinders';
import { db } from '../db/db';
import { GAS_TYPES, type Cylinder } from '../db/types';

export default function Cylinders() {
  const settings = useSettings();
  const { can } = useAuth();
  const toast = useToast();
  const { run, busy } = useAction();
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const data = useLiveQuery(async () => {
    const [items, cylinders, openMoves, technicians, losses] = await Promise.all([
      db.items.filter((i) => GAS_TYPES.includes(i.type)).toArray(),
      db.cylinders.toArray(),
      db.cylinderMoves.filter((m) => !m.inAt).toArray(),
      db.technicians.toArray(),
      db.movements.where('kind').equals('Loss').reverse().sortBy('at'),
    ]);
    const complaints = new Map(
      (await db.complaints.bulkGet([...new Set(openMoves.map((m) => m.complaintId).filter((x): x is string => !!x))]))
        .filter(Boolean)
        .map((c) => [c!.id, c!]),
    );
    return {
      items: new Map(items.map((i) => [i.id, i])),
      gasItems: items.filter((i) => i.active),
      cylinders: cylinders.sort((a, b) => a.tag.localeCompare(b.tag)),
      openMoves: new Map(openMoves.map((m) => [m.id, m])),
      technicians: new Map(technicians.map((t) => [t.id, t])),
      complaints,
      losses: losses.slice(0, 20),
    };
  }, []);

  if (!data) return <Loading />;
  const { items, cylinders, openMoves, technicians, complaints, losses } = data;
  const shown = cylinders.filter((c) => showRetired || c.status !== 'Retired');
  const now = Date.now();
  const overdue = cylinders.filter(
    (c) => c.status === 'Out' && c.openMoveId && now - Date.parse(openMoves.get(c.openMoveId)?.outAt ?? '') > OVERDUE_HOURS * 3600000,
  );
  const lossValue = losses.reduce((t, m) => t + -m.qty * (items.get(m.itemId)?.unitCost ?? 0), 0);

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Gas cylinders</h1>
          <div className="small muted">Weigh every cylinder out and back in. The difference is the gas used on the job.</div>
        </div>
        <span className="spacer" />
        <label className="field inline">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        <button className="primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Register cylinder'}
        </button>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">In store</div>
          <div className="value">{cylinders.filter((c) => c.status === 'In store').length}</div>
        </div>
        <div className="card kpi">
          <div className="label">Out with technicians</div>
          <div className="value">{cylinders.filter((c) => c.status === 'Out').length}</div>
        </div>
        <div className={`card kpi ${overdue.length ? 'bad' : 'ok'}`}>
          <div className="label">Out more than {OVERDUE_HOURS} h</div>
          <div className="value">{overdue.length}</div>
        </div>
        <div className={`card kpi ${losses.length ? 'warn' : 'ok'}`}>
          <div className="label">Gas lost in store (recent)</div>
          <div className="value" style={{ fontSize: '1.3rem' }}>
            {fmtMoney(lossValue, settings.currency)}
          </div>
          <div className="small muted">{losses.length} occurrence(s)</div>
        </div>
      </div>

      {adding && <RegisterForm onDone={() => setAdding(false)} />}

      {shown.length === 0 ? (
        <div className="card">
          <Empty>No cylinders registered yet. Register each refrigerant, nitrogen, oxygen and fuel-gas cylinder with its tag.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cylinder</th>
                  <th className="num">Contents</th>
                  <th>Where</th>
                  <th style={{ width: 280 }}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const item = items.get(c.itemId);
                  const move = c.openMoveId ? openMoves.get(c.openMoveId) : undefined;
                  const late = move && now - Date.parse(move.outAt) > OVERDUE_HOURS * 3600000;
                  return (
                    <tr key={c.id} style={{ opacity: c.status === 'Retired' ? 0.5 : 1 }}>
                      <td>
                        <strong>{c.tag}</strong>
                        <div className="small muted">
                          {item?.name}
                          {c.measure === 'weight' ? ` · tare ${c.tareKg} kg` : ` · ${c.capacityL} L`}
                        </div>
                      </td>
                      <td className="num">
                        {fmtNum(contentAt(c, c.lastReading), 3)} {item?.unit}
                        <div className="small muted">
                          {c.lastReading} {readingUnit(c.measure)} · {fmtDateTime(c.lastReadingAt)}
                        </div>
                      </td>
                      <td>
                        {c.status === 'Out' && move ? (
                          <>
                            <span className={`badge ${late ? 'bad' : 'primary'}`}>Out {fmtDuration(now - Date.parse(move.outAt))}</span>
                            <div className="small">
                              {move.technicianId ? technicians.get(move.technicianId)?.name : 'No technician'}
                              {move.complaintId && (
                                <>
                                  {' · '}
                                  <Link to={`/complaints/${move.complaintId}`}>{complaints.get(move.complaintId)?.ticketNo ?? 'job'}</Link>
                                </>
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="badge">{c.status}</span>
                        )}
                      </td>
                      <td>{c.status !== 'Retired' && <CylinderActions c={c} canRetire={can('adjustStock')} busy={busy} run={run} toast={toast} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {losses.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Gas lost while in the store</h2>
          <p className="small muted">
            Found when a cylinder weighed less at weigh-out than when it was last weighed. Check valves for leaks and whether gas was
            used without being booked.
          </p>
          <div className="table-wrap">
            <table>
              <tbody>
                {losses.map((m) => (
                  <tr key={m.id}>
                    <td className="small nowrap">{fmtDateTime(m.at)}</td>
                    <td>
                      {m.reference} · {items.get(m.itemId)?.name}
                      <div className="small muted">{m.note}</div>
                    </td>
                    <td className="num" style={{ color: 'var(--bad)' }}>
                      {fmtNum(-m.qty, 3)} {items.get(m.itemId)?.unit}
                    </td>
                    <td className="small">{m.byEmail ?? m.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CylinderActions({
  c,
  canRetire,
  busy,
  run,
  toast,
}: {
  c: Cylinder;
  canRetire: boolean;
  busy: boolean;
  run: (fn: () => Promise<unknown>, msg?: string) => Promise<boolean>;
  toast: (m: string) => void;
}) {
  const settings = useSettings();
  const technicians = useLiveQuery(() => db.technicians.filter((t) => t.active).sortBy('name'), []);
  const [mode, setMode] = useState<'' | 'out' | 'in' | 'refill'>('');
  const [reading, setReading] = useState('');
  const [tech, setTech] = useState('');
  const unit = readingUnit(c.measure);
  const reset = () => {
    setMode('');
    setReading('');
  };

  if (!mode) {
    return (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {c.status === 'In store' ? (
          <>
            <button className="sm" onClick={() => setMode('out')}>
              Weigh out
            </button>
            <button className="sm" onClick={() => setMode('refill')}>
              Refill
            </button>
            {canRetire && (
              <button
                className="sm danger"
                disabled={busy}
                onClick={() => {
                  const note = prompt('Why is this cylinder being retired? (returned to supplier, condemned…) Any gas left is written off.');
                  if (note) run(() => retireCylinder(db, settings, c.id, note), 'Cylinder retired');
                }}
              >
                Retire
              </button>
            )}
          </>
        ) : (
          <button className="sm primary" onClick={() => setMode('in')}>
            Weigh in
          </button>
        )}
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = Number(reading);
    run(async () => {
      if (mode === 'out') {
        const res = await weighOut(db, settings, { cylinderId: c.id, reading: r, technicianId: tech || undefined });
        toast(res.loss > 0 ? `Weighed out. ${fmtNum(res.loss, 3)} missing since last weigh-in, recorded as a loss.` : 'Weighed out');
      } else if (mode === 'in') {
        const res = await weighIn(db, settings, { cylinderId: c.id, reading: r });
        toast(`Weighed in: ${fmtNum(res.used, 3)} ${res.unit} used`);
      } else {
        const added = await refillCylinder(db, settings, c.id, r);
        toast(`Refill recorded: +${fmtNum(added, 3)}`);
      }
      reset();
    });
  };

  return (
    <form className="row" onSubmit={submit} style={{ justifyContent: 'flex-end' }}>
      {mode === 'out' && (
        <select value={tech} onChange={(e) => setTech(e.target.value)} style={{ width: 150 }}>
          <option value="">Technician…</option>
          {technicians?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <input
        type="number"
        step="any"
        min="0"
        inputMode="decimal"
        autoFocus
        required
        placeholder={`${mode === 'refill' ? 'Full reading' : 'Reading'} (${unit})`}
        value={reading}
        onChange={(e) => setReading(e.target.value)}
        style={{ width: 130 }}
      />
      <button className="sm primary" disabled={busy}>
        Save
      </button>
      <button type="button" className="sm" onClick={reset}>
        Cancel
      </button>
    </form>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const gasItems = useLiveQuery(() => db.items.filter((i) => i.active && GAS_TYPES.includes(i.type)).sortBy('name'), []);
  const [f, setF] = useState({ tag: '', itemId: '', tare: '', capacity: '', reading: '', counted: false, reference: '' });
  const item = gasItems?.find((i) => i.id === f.itemId);
  const measure = item ? measureFor(item) : 'weight';
  const content =
    item && f.reading !== '' ? contentAt({ measure, tareKg: Number(f.tare) || 0, capacityL: Number(f.capacity) || 0 }, Number(f.reading)) : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await registerCylinder(db, settings, {
        tag: f.tag,
        itemId: f.itemId,
        tareKg: f.tare === '' ? undefined : Number(f.tare),
        capacityL: f.capacity === '' ? undefined : Number(f.capacity),
        reading: Number(f.reading),
        alreadyInStock: f.counted,
        reference: f.reference || undefined,
      });
      onDone();
    }, 'Cylinder registered');
  };

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}>
      <h2>Register a cylinder</h2>
      <div className="form-grid">
        <label className="field">
          Tag / number *
          <input required value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} placeholder="e.g. R32-07" />
        </label>
        <label className="field">
          Gas *
          <select required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}>
            <option value="">Choose…</option>
            {gasItems?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit})
              </option>
            ))}
          </select>
        </label>
        {measure === 'weight' ? (
          <label className="field">
            Empty (tare) weight, kg *
            <input type="number" step="any" min="0" required value={f.tare} onChange={(e) => setF({ ...f, tare: e.target.value })} />
            <span className="hint">Stamped on the cylinder (TW)</span>
          </label>
        ) : (
          <label className="field">
            Water capacity, litres *
            <input type="number" step="any" min="0" required value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
            <span className="hint">e.g. 50 L for a standard industrial cylinder</span>
          </label>
        )}
        <label className="field">
          Current {measure === 'weight' ? 'gross weight, kg' : 'pressure, bar'} *
          <input type="number" step="any" min="0" required value={f.reading} onChange={(e) => setF({ ...f, reading: e.target.value })} />
          {content !== undefined && (
            <span className="hint">
              Contains {fmtNum(content, 3)} {item?.unit}
            </span>
          )}
        </label>
        <label className="field">
          GRN / invoice ref.
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </label>
        <label className="field inline span-all">
          <input type="checkbox" checked={f.counted} onChange={(e) => setF({ ...f, counted: e.target.checked })} />
          This gas is already counted in stock (e.g. imported from the stock sheet). Don't add it again.
        </label>
      </div>
      <button className="primary" disabled={busy} style={{ marginTop: 12 }}>
        Register
      </button>
    </form>
  );
}
