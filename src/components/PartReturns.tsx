import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/db';
import { advanceReturn, createReturn, isReturnLate, nextStages } from '../db/returns';
import type { MaterialUsage } from '../lib/consumption';
import type { Complaint, PartReturn, ReturnStage } from '../db/types';
import { useSettings } from './SettingsContext';
import { fmtDateTime, useAction } from './ui';

/** Moves a return to its next stage, with the details that stage needs. */
export function ReturnActions({ r, onDone }: { r: PartReturn; onDone?: () => void }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const options = nextStages(r.stage);
  const [stage, setStage] = useState<ReturnStage>(options[0] ?? r.stage);
  const [f, setF] = useState({ note: '', waybill: '', carrier: '', claimRef: '' });
  if (!options.length) return null;
  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field">
          Move to
          <select value={stage} onChange={(e) => setStage(e.target.value as ReturnStage)}>
            {options.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {stage === 'In transit to Lagos' && (
          <>
            <label className="field">
              Waybill
              <input value={f.waybill} onChange={(e) => setF({ ...f, waybill: e.target.value })} />
            </label>
            <label className="field">
              Carrier
              <input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} placeholder="e.g. GIG Logistics" />
            </label>
          </>
        )}
        {stage === 'Sent to principal' && (
          <label className="field">
            Claim / RMA number *
            <input value={f.claimRef} onChange={(e) => setF({ ...f, claimRef: e.target.value })} />
          </label>
        )}
        <label className="field">
          {stage === 'Scrapped' ? 'Reason *' : 'Note'}
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <button className="primary sm" disabled={busy} onClick={() => run(async () => {
          await advanceReturn(db, settings, r.id, stage, f);
          onDone?.();
        }, `Moved to ${stage}`)}>
          Save
        </button>
      </div>
      <ul className="timeline">
        {[...r.history].reverse().map((h, i) => (
          <li key={i}>
            <div>
              {h.stage}
              {h.note && <span className="muted"> · {h.note}</span>}
            </div>
            <div className="meta">
              {fmtDateTime(h.at)} · {h.by}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}


/** On a complaint: the defective parts coming back from this job. */
export function ComplaintReturnsCard({ c, usage }: { c: Complaint; usage?: MaterialUsage[] }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const returns = useLiveQuery(() => db.partReturns.where('complaintId').equals(c.id).toArray(), [c.id]);
  const [adding, setAdding] = useState(false);
  const [itemId, setItemId] = useState('');
  const [partName, setPartName] = useState('');
  const [partSerial, setPartSerial] = useState('');
  const [stage, setStage] = useState<ReturnStage>('With technician');
  const [open, setOpen] = useState<string>();
  const spares = (usage ?? []).filter((u) => u.item.type === 'Spare');
  const pending = spares.filter((u) => !returns?.some((r) => r.itemId === u.item.id));
  const warranty = c.equipment.warranty === 'In Warranty' || c.equipment.warranty === 'AMC';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await createReturn(db, settings, { complaintId: c.id, itemId: itemId || undefined, partName, partSerial, stage });
      setAdding(false);
      setItemId('');
      setPartName('');
      setPartSerial('');
    }, 'Return registered');
  };

  if (!returns) return null;
  if (!returns.length && !spares.length && !adding) {
    return (
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Defective part return</h2>
          <button className="sm" onClick={() => setAdding(true)}>
            Register part
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Defective part return</h2>
        {!adding && (
          <button className="sm" onClick={() => setAdding(true)}>
            Register part
          </button>
        )}
      </div>
      {warranty && pending.length > 0 && !adding && (
        <p className="small" style={{ color: 'var(--warn)', marginTop: 8 }}>
          {pending.map((u) => u.item.name).join(', ')} replaced under warranty: register the old part so it comes back to Lagos for the claim.
        </p>
      )}
      {adding && (
        <form onSubmit={submit} className="form-grid" style={{ marginTop: 10 }}>
          <label className="field span-all">
            Part
            <select
              value={itemId}
              onChange={(e) => {
                setItemId(e.target.value);
                setPartName(spares.find((u) => u.item.id === e.target.value)?.item.name ?? '');
              }}
            >
              <option value="">Other part (type below)</option>
              {spares.map((u) => (
                <option key={u.item.id} value={u.item.id}>
                  {u.item.name}
                </option>
              ))}
            </select>
          </label>
          {!itemId && (
            <label className="field span-all">
              Part name *
              <input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="e.g. Outdoor PCB, compressor" />
            </label>
          )}
          <label className="field">
            Part serial no.
            <input value={partSerial} onChange={(e) => setPartSerial(e.target.value)} />
          </label>
          <label className="field">
            Where is it now
            <select value={stage} onChange={(e) => setStage(e.target.value as ReturnStage)}>
              {(['At site', 'With technician', 'At branch'] as ReturnStage[]).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="row span-all">
            <button type="submit" className="primary sm" disabled={busy || !(itemId || partName.trim())}>
              Register
            </button>
            <button type="button" className="sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {returns.map((r) => (
        <div key={r.id} style={{ marginTop: 10 }}>
          <div className="row between">
            <span>
              <strong>{r.ref}</strong> {r.partName}
              {r.partSerial && <span className="muted small"> · S/N {r.partSerial}</span>}
            </span>
            <span className={`badge ${isReturnLate(r) ? 'bad' : ''}`}>{r.stage}</span>
          </div>
          {nextStages(r.stage).length > 0 &&
            (open === r.id ? (
              <div style={{ marginTop: 8 }}>
                <ReturnActions r={r} onDone={() => setOpen(undefined)} />
              </div>
            ) : (
              <button className="link small" onClick={() => setOpen(r.id)}>
                Update
              </button>
            ))}
        </div>
      ))}
      {returns.length > 0 && (
        <p className="small muted" style={{ marginTop: 8 }}>
          All returns: <Link to="/returns">Part returns</Link>
        </p>
      )}
    </div>
  );
}

