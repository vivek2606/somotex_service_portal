import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDate, fmtDateTime, fmtDuration, Loading, useAction } from '../components/ui';
import { db } from '../db/db';
import {
  calibrateTool,
  calibrationState,
  DEFAULT_CALIBRATION,
  isToolOverdue,
  issueTool,
  registerTool,
  retireTool,
  returnTool,
  sendToolForRepair,
  TOOL_OUT_DAYS,
  toolRepaired,
  type CalibrationState,
} from '../db/tools';
import { TOOL_KINDS, type Technician, type Tool, type ToolKind } from '../db/types';

const CAL_BADGE: Record<CalibrationState, [string, string] | undefined> = {
  none: undefined,
  ok: ['ok', 'Calibrated'],
  'due-soon': ['warn', 'Calibration due soon'],
  overdue: ['bad', 'Calibration overdue'],
};

export default function Tools() {
  const settings = useSettings();
  const [adding, setAdding] = useState(false);
  const [branch, setBranch] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [open, setOpen] = useState<string>();
  const data = useLiveQuery(async () => {
    const [tools, technicians] = await Promise.all([db.tools.toArray(), db.technicians.toArray()]);
    return { tools: tools.sort((a, b) => a.tag.localeCompare(b.tag)), technicians };
  }, []);
  if (!data) return <Loading />;
  const techs = new Map(data.technicians.map((t) => [t.id, t]));
  const live = data.tools.filter((t) => t.status !== 'Retired');
  const shown = data.tools.filter((t) => (showRetired || t.status !== 'Retired') && (!branch || t.branch === branch));
  const overdueCal = live.filter((t) => calibrationState(t) === 'overdue');
  const soonCal = live.filter((t) => calibrationState(t) === 'due-soon');
  const outLong = live.filter((t) => isToolOverdue(t));

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Tools</h1>
          <div className="small muted">Who has each tool, and when it is due for calibration.</div>
        </div>
        <span className="spacer" />
        <select value={branch} onChange={(e) => setBranch(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All branches</option>
          {settings.branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <label className="field inline">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        <button className="primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Register tool'}
        </button>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">Tools in use</div>
          <div className="value">{live.length}</div>
          <div className="small muted">{live.filter((t) => t.status === 'Issued').length} with technicians</div>
        </div>
        <div className={`card kpi ${overdueCal.length ? 'bad' : 'ok'}`}>
          <div className="label">Calibration overdue</div>
          <div className="value">{overdueCal.length}</div>
          <div className="small muted">{soonCal.length} due within 14 days</div>
        </div>
        <div className={`card kpi ${outLong.length ? 'warn' : 'ok'}`}>
          <div className="label">Out more than {TOOL_OUT_DAYS} days</div>
          <div className="value">{outLong.length}</div>
        </div>
        <div className="card kpi">
          <div className="label">Under repair</div>
          <div className="value">{live.filter((t) => t.status === 'Under repair').length}</div>
        </div>
      </div>

      {overdueCal.some((t) => t.kind === 'Charging scale') && (
        <div className="alert-box critical" style={{ marginBottom: 14 }}>
          A charging scale is overdue for calibration ({overdueCal.filter((t) => t.kind === 'Charging scale').map((t) => t.tag).join(', ')}).
          Cylinder weights and gas charged with it can’t be trusted until it is checked against a known weight.
        </div>
      )}

      {adding && <RegisterTool onDone={() => setAdding(false)} />}

      {shown.length === 0 ? (
        <div className="card">
          <Empty>No tools registered. Register vacuum pumps, gauge sets, charging scales and brazing kits with their tag.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Branch</th>
                  <th>Where</th>
                  <th>Calibration</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const cal = CAL_BADGE[calibrationState(t)];
                  return (
                    <ToolRow
                      key={t.id}
                      t={t}
                      tech={t.technicianId ? techs.get(t.technicianId) : undefined}
                      cal={cal}
                      open={open === t.id}
                      toggle={() => setOpen(open === t.id ? undefined : t.id)}
                      technicians={data.technicians}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRow({
  t,
  tech,
  cal,
  open,
  toggle,
  technicians,
}: {
  t: Tool;
  tech?: Technician;
  cal?: [string, string];
  open: boolean;
  toggle: () => void;
  technicians: Technician[];
}) {
  const late = isToolOverdue(t);
  return (
    <>
      <tr style={{ opacity: t.status === 'Retired' ? 0.5 : 1 }}>
        <td>
          <strong>{t.tag}</strong>
          <div className="small muted">
            {t.kind}
            {t.description && ` · ${t.description}`}
            {t.serialNo && ` · S/N ${t.serialNo}`}
          </div>
        </td>
        <td className="small">{t.branch}</td>
        <td>
          {t.status === 'Issued' ? (
            <>
              <span className={`badge ${late ? 'bad' : 'primary'}`}>
                {tech?.name ?? 'Technician'} · {fmtDuration(Date.now() - Date.parse(t.issuedAt ?? ''))}
              </span>
            </>
          ) : (
            <span className={`badge ${t.status === 'Under repair' ? 'warn' : ''}`}>{t.status}</span>
          )}
        </td>
        <td className="small">
          {cal ? (
            <>
              <span className={`badge ${cal[0]}`}>{cal[1]}</span>
              <div className="muted">{t.calibrationDue ? `due ${fmtDate(t.calibrationDue)}` : 'never calibrated'}</div>
            </>
          ) : (
            <span className="muted">not needed</span>
          )}
        </td>
        <td className="right">
          {t.status !== 'Retired' && (
            <button className="sm" onClick={toggle}>
              {open ? 'Close' : 'Actions'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
            <ToolActions t={t} technicians={technicians} onDone={toggle} />
          </td>
        </tr>
      )}
    </>
  );
}

function ToolActions({ t, technicians, onDone }: { t: Tool; technicians: Technician[]; onDone: () => void }) {
  const settings = useSettings();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const [techId, setTechId] = useState('');
  const [note, setNote] = useState('');
  const [calDate, setCalDate] = useState(new Date().toISOString().slice(0, 10));
  const history = useLiveQuery(() => db.toolMoves.where('toolId').equals(t.id).reverse().sortBy('at'), [t.id]);
  const techName = (id?: string) => technicians.find((x) => x.id === id)?.name;
  const act = (fn: () => Promise<unknown>, msg: string) =>
    run(async () => {
      await fn();
      setNote('');
    }, msg);
  const overdue = calibrationState(t) === 'overdue';

  return (
    <div className="stack">
      <div className="form-grid">
        {t.status === 'In store' && (
          <label className="field">
            Issue to
            <select value={techId} onChange={(e) => setTechId(e.target.value)}>
              <option value="">Choose technician…</option>
              {technicians
                .filter((x) => x.active)
                .sort((a, b) => Number(b.branch === t.branch) - Number(a.branch === t.branch) || a.name.localeCompare(b.name))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.branch && x.branch !== t.branch ? ` (${x.branch})` : ''}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          {t.status === 'In store' && overdue ? 'Reason to issue while uncalibrated' : 'Note'}
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {t.status !== 'Retired' && (
          <label className="field">
            Calibrated on
            <input type="date" value={calDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setCalDate(e.target.value)} />
          </label>
        )}
      </div>
      <div className="row">
        {t.status === 'In store' && (
          <button className="primary sm" disabled={busy || !techId} onClick={() => act(() => issueTool(db, settings, t.id, techId, undefined, note), 'Tool issued')}>
            Issue
          </button>
        )}
        {t.status === 'Issued' && (
          <button className="primary sm" disabled={busy} onClick={() => act(() => returnTool(db, settings, t.id, note), 'Tool returned')}>
            Returned to store
          </button>
        )}
        <button className="sm" disabled={busy} onClick={() => act(() => calibrateTool(db, settings, t.id, calDate, note), 'Calibration recorded')}>
          Record calibration
        </button>
        {t.status !== 'Under repair' ? (
          <button className="sm" disabled={busy || !note.trim()} title="Describe the fault in the note" onClick={() => act(() => sendToolForRepair(db, settings, t.id, note), 'Sent for repair')}>
            Send for repair
          </button>
        ) : (
          <button className="sm" disabled={busy} onClick={() => act(() => toolRepaired(db, settings, t.id, note), 'Back from repair')}>
            Back from repair
          </button>
        )}
        {can('adjustStock') && (
          <button
            className="sm"
            disabled={busy || !note.trim()}
            title="Give the reason in the note"
            onClick={() => confirm(`Retire ${t.tag}?`) && act(() => retireTool(db, settings, t.id, note).then(onDone), 'Tool retired')}
          >
            Retire
          </button>
        )}
      </div>
      {!!history?.length && (
        <ul className="timeline" style={{ marginTop: 6 }}>
          {history.slice(0, 12).map((h) => (
            <li key={h.id}>
              <div>
                {h.kind}
                {h.technicianId && ` · ${techName(h.technicianId) ?? ''}`}
                {h.note && <span className="muted"> · {h.note}</span>}
              </div>
              <div className="meta">
                {fmtDateTime(h.at)} · {h.byEmail ?? h.by}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RegisterTool({ onDone }: { onDone: () => void }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<ToolKind>('Vacuum pump');
  const [f, setF] = useState({ tag: '', description: '', serialNo: '', branch: settings.branches[0] ?? '', lastCalibratedAt: '', notes: '' });
  const [months, setMonths] = useState<string>('');
  const suggested = DEFAULT_CALIBRATION[kind];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await registerTool(db, settings, { ...f, kind, calibrationMonths: months === '' ? suggested : Number(months) });
      onDone();
    }, 'Tool registered');
  };
  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}>
      <h2>Register a tool</h2>
      <div className="form-grid">
        <label className="field">
          Tag *
          <input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} placeholder="e.g. VP-03" required />
        </label>
        <label className="field">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as ToolKind)}>
            {TOOL_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Make / model
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Value VE215N" />
        </label>
        <label className="field">
          Serial number
          <input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} />
        </label>
        <label className="field">
          Branch
          <select value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })}>
            {settings.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Calibrate every (months)
          <input type="number" min="0" value={months} placeholder={suggested ? String(suggested) : 'not needed'} onChange={(e) => setMonths(e.target.value)} />
          <span className="hint">{suggested ? `Typical for a ${kind.toLowerCase()}: ${suggested} months. Enter 0 if not needed.` : 'Leave empty if it doesn’t need calibration.'}</span>
        </label>
        <label className="field">
          Last calibrated
          <input type="date" value={f.lastCalibratedAt} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, lastCalibratedAt: e.target.value })} />
        </label>
      </div>
      <button type="submit" className="primary" disabled={busy} style={{ marginTop: 12 }}>
        Register
      </button>
    </form>
  );
}
