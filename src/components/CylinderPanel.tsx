import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { contentAt, readingUnit, weighIn, weighOut } from '../db/cylinders';
import { db } from '../db/db';
import type { Complaint } from '../db/types';
import { useSettings } from './SettingsContext';
import { fmtDateTime, fmtNum, useAction, useToast } from './ui';

/**
 * Cylinders on a job: weigh one out to the technician, or weigh it back in
 * to book the gas actually used.
 */
export function CylinderPanel({ c }: { c: Complaint }) {
  const settings = useSettings();
  const toast = useToast();
  const { run, busy } = useAction();
  const data = useLiveQuery(async () => {
    const [items, cylinders, moves] = await Promise.all([
      db.items.toArray(),
      db.cylinders.filter((x) => x.status !== 'Retired').toArray(),
      db.cylinderMoves.where('complaintId').equals(c.id).toArray(),
    ]);
    return { items: new Map(items.map((i) => [i.id, i])), cylinders, moves };
  }, [c.id]);
  const [cylId, setCylId] = useState('');
  const [reading, setReading] = useState('');
  const [inReading, setInReading] = useState<Record<string, string>>({});

  if (!data) return null;
  const { items, cylinders, moves } = data;
  // Offer cylinders of this unit's refrigerant first, then the other gases.
  const available = cylinders
    .filter((x) => x.status === 'In store')
    .filter((x) => {
      const it = items.get(x.itemId);
      return it && (it.type !== 'Refrigerant' || !c.equipment.refrigerant || it.refrigerant === c.equipment.refrigerant);
    })
    .sort((a, b) => a.tag.localeCompare(b.tag));
  const out = moves.filter((m) => !m.inAt);
  const done = moves.filter((m) => m.inAt);
  const selected = cylinders.find((x) => x.id === cylId);

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Gas cylinders on this job</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Weigh the cylinder before it leaves and when it comes back. The difference is booked to this job as gas used.
      </p>
      {out.map((m) => {
        const cyl = cylinders.find((x) => x.id === m.cylinderId);
        const item = items.get(m.itemId);
        if (!cyl) return null;
        const unit = readingUnit(cyl.measure);
        const r = Number(inReading[m.id]);
        const preview = inReading[m.id] && r >= 0 ? Math.max(0, contentAt(cyl, m.outReading) - contentAt(cyl, r)) : undefined;
        return (
          <div key={m.id} className="alert-box info">
            <div className="row between">
              <strong>
                {cyl.tag} · {item?.name}
              </strong>
              <span className="small">
                out {fmtDateTime(m.outAt)} at {m.outReading} {unit}
              </span>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                placeholder={`Reading now (${unit})`}
                value={inReading[m.id] ?? ''}
                onChange={(e) => setInReading({ ...inReading, [m.id]: e.target.value })}
                style={{ width: 170 }}
              />
              <button
                className="sm primary"
                disabled={busy || !inReading[m.id]}
                onClick={() =>
                  run(async () => {
                    const res = await weighIn(db, settings, { cylinderId: cyl.id, reading: r });
                    setInReading({ ...inReading, [m.id]: '' });
                    toast(`Weighed in: ${fmtNum(res.used, 3)} ${res.unit} used`);
                  })
                }
              >
                Weigh in
              </button>
              {preview !== undefined && (
                <span className="small">
                  = {fmtNum(preview, 3)} {item?.unit} used
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 8 }}>
        <select value={cylId} onChange={(e) => setCylId(e.target.value)} style={{ flex: '2 1 200px' }}>
          <option value="">Weigh out a cylinder…</option>
          {available.map((x) => (
            <option key={x.id} value={x.id}>
              {x.tag} · {items.get(x.itemId)?.name} · last {x.lastReading} {readingUnit(x.measure)}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          placeholder={selected ? `Reading (${readingUnit(selected.measure)})` : 'Reading'}
          value={reading}
          onChange={(e) => setReading(e.target.value)}
          style={{ flex: '1 1 120px' }}
        />
        <button
          className="sm"
          disabled={busy || !cylId || reading === ''}
          onClick={() =>
            run(async () => {
              const res = await weighOut(db, settings, { cylinderId: cylId, reading: Number(reading), complaintId: c.id });
              setCylId('');
              setReading('');
              toast(res.loss > 0 ? `Weighed out. ${fmtNum(res.loss, 3)} was missing since it was last weighed in the store.` : 'Weighed out');
            })
          }
        >
          Weigh out
        </button>
      </div>
      {done.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <tbody>
              {done.map((m) => {
                const cyl = cylinders.find((x) => x.id === m.cylinderId);
                const unit = cyl ? readingUnit(cyl.measure) : '';
                return (
                  <tr key={m.id}>
                    <td className="small">{cyl?.tag ?? 'Cylinder'}</td>
                    <td className="small">
                      {m.outReading} → {m.inReading} {unit}
                    </td>
                    <td className="num small">
                      {fmtNum(m.used ?? 0, 3)} {items.get(m.itemId)?.unit} used
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
