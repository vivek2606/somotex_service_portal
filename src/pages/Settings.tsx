import { useEffect, useState } from 'react';
import { useSettings } from '../components/SettingsContext';
import { useAction } from '../components/ui';
import { db } from '../db/db';
import { loadDemoData, seedIfEmpty } from '../db/seed';
import { exportAll, importAll } from '../db/service';
import { saveSettings, type AppSettings } from '../db/settings';
import { REFRIGERANTS, type JobType, type Priority } from '../db/types';
import { DEFAULT_NORMS } from '../lib/consumption';
import { downloadText } from '../lib/csv';

export default function Settings() {
  const current = useSettings();
  const { run, busy } = useAction();
  const [s, setS] = useState<AppSettings>(current);
  const [tab, setTab] = useState<'general' | 'norms' | 'data'>('general');
  useEffect(() => setS(current), [current]);
  const dirty = JSON.stringify(s) !== JSON.stringify(current);
  const n = s.norms;
  const setNorms = (patch: Partial<AppSettings['norms']>) => setS({ ...s, norms: { ...n, ...patch } });
  const num = (v: string) => (v === '' ? 0 : Number(v));

  const save = () => run(() => saveSettings(db, s), 'Settings saved');

  return (
    <div>
      <div className="topbar">
        <h1>Settings</h1>
        <span className="spacer" />
        {dirty && (
          <button className="primary" onClick={save} disabled={busy}>
            Save changes
          </button>
        )}
      </div>
      <div className="tabs">
        {(['general', 'norms', 'data'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'general' ? 'General' : t === 'norms' ? 'Gas norms' : 'Data & backup'}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="stack">
          <div className="card">
            <h2>Organisation &amp; user</h2>
            <div className="form-grid">
              <label className="field">
                Company name
                <input value={s.companyName} onChange={(e) => setS({ ...s, companyName: e.target.value })} />
              </label>
              <label className="field">
                Your name on this device <span className="hint">recorded on every entry</span>
                <input value={s.currentUser} onChange={(e) => setS({ ...s, currentUser: e.target.value })} />
              </label>
              <label className="field">
                Currency
                <input value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value })} />
              </label>
              <label className="field">
                Ticket prefix
                <input value={s.ticketPrefix} onChange={(e) => setS({ ...s, ticketPrefix: e.target.value.toUpperCase() })} />
              </label>
            </div>
          </div>

          <div className="card">
            <h2>Target resolution time (hours)</h2>
            <div className="form-grid">
              {(Object.keys(s.slaHours) as Priority[]).map((p) => (
                <label className="field" key={p}>
                  {p}
                  <input type="number" min="1" value={s.slaHours[p]} onChange={(e) => setS({ ...s, slaHours: { ...s.slaHours, [p]: num(e.target.value) } })} />
                </label>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Brands</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>In-house (assembled locally)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {s.brands.map((b, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={b.name}
                          onChange={(e) => setS({ ...s, brands: s.brands.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={b.inHouse}
                          onChange={(e) => setS({ ...s, brands: s.brands.map((x, j) => (j === i ? { ...x, inHouse: e.target.checked } : x)) })}
                        />
                      </td>
                      <td className="right">
                        <button className="sm" onClick={() => setS({ ...s, brands: s.brands.filter((_, j) => j !== i) })}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button style={{ marginTop: 10 }} onClick={() => setS({ ...s, brands: [...s.brands, { name: '', inHouse: false }] })}>
              Add brand
            </button>
          </div>

          <div className="card">
            <h2>Complaint types</h2>
            <label className="field">
              One per line
              <textarea
                rows={10}
                value={s.complaintTypes.join('\n')}
                onChange={(e) => setS({ ...s, complaintTypes: e.target.value.split('\n') })}
                onBlur={() => setS({ ...s, complaintTypes: s.complaintTypes.map((t) => t.trim()).filter(Boolean) })}
              />
            </label>
          </div>
        </div>
      )}

      {tab === 'norms' && (
        <div className="stack">
          <div className="card">
            <h2>Alert thresholds</h2>
            <p className="small muted">
              Each job gets a gas budget from the unit's capacity, refrigerant, job type, pipe length, brazed joints, flushing and
              pressure test. Use above budget + tolerance raises a warning; above budget + critical raises a critical alert.
              Budgets for brazing gas, nitrogen and flushing solvent are set on each inventory item.
            </p>
            <div className="form-grid">
              <label className="field">
                Tolerance (%)
                <input type="number" min="0" value={n.tolerancePct} onChange={(e) => setNorms({ tolerancePct: num(e.target.value) })} />
              </label>
              <label className="field">
                Critical above (%)
                <input type="number" min="0" value={n.criticalPct} onChange={(e) => setNorms({ criticalPct: num(e.target.value) })} />
              </label>
              <label className="field">
                Hose / purge allowance (g)
                <input type="number" min="0" value={n.hoseLossG} onChange={(e) => setNorms({ hoseLossG: num(e.target.value) })} />
              </label>
              <label className="field">
                Pre-charged pipe length (m)
                <input type="number" min="0" step="any" value={n.prechargedPipeM} onChange={(e) => setNorms({ prechargedPipeM: num(e.target.value) })} />
              </label>
              <label className="field">
                Repeat-charge window (days)
                <input type="number" min="1" value={n.repeatWindowDays} onChange={(e) => setNorms({ repeatWindowDays: num(e.target.value) })} />
              </label>
            </div>
          </div>

          <div className="card">
            <h2>Refrigerant charge norms</h2>
            <p className="small muted">
              Used when the nameplate charge isn't entered. g/kW applies to ACs (1 TR = 3.517 kW, 12,000 BTU/h = 3.517 kW); g/L to
              fridges and freezers; g/m to pipe beyond the pre-charged length.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Refrigerant</th>
                    <th className="num">g per kW</th>
                    <th className="num">g per litre</th>
                    <th className="num">g per extra pipe m</th>
                  </tr>
                </thead>
                <tbody>
                  {REFRIGERANTS.map((r) => (
                    <tr key={r}>
                      <td>{r}</td>
                      {(['gPerKw', 'gPerLitre', 'pipeGPerM'] as const).map((k) => (
                        <td key={k}>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={n.refrigerants[r][k]}
                            onChange={(e) => setNorms({ refrigerants: { ...n.refrigerants, [r]: { ...n.refrigerants[r], [k]: num(e.target.value) } } })}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>Job types</h2>
            <p className="small muted">Share of the full system charge each job type normally needs, and whether extra pipe charge applies.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job type</th>
                    <th className="num">% of full charge</th>
                    <th>Pipe charge</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(n.jobs) as JobType[]).map((j) => (
                    <tr key={j}>
                      <td>{j}</td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          max="200"
                          value={Math.round(n.jobs[j].chargeFraction * 100)}
                          onChange={(e) => setNorms({ jobs: { ...n.jobs, [j]: { ...n.jobs[j], chargeFraction: num(e.target.value) / 100 } } })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={n.jobs[j].pipeCharge}
                          onChange={(e) => setNorms({ jobs: { ...n.jobs, [j]: { ...n.jobs[j], pipeCharge: e.target.checked } } })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button style={{ marginTop: 10 }} onClick={() => setNorms(DEFAULT_NORMS)}>
              Restore default norms
            </button>
          </div>
        </div>
      )}

      {tab === 'data' && (
        <div className="stack">
          <div className="card">
            <h2>Backup &amp; restore</h2>
            <p className="small muted">
              All data is stored on this device, and the app works offline. Download a backup regularly and keep it safe.
            </p>
            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  run(async () => {
                    const data = await exportAll(db);
                    downloadText(`service-portal-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
                  })
                }
              >
                Download backup
              </button>
              <label className="btn">
                Restore from backup…
                <input
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file || !confirm('Restoring replaces ALL data on this device with the backup. Continue?')) return;
                    run(async () => importAll(db, JSON.parse(await file.text())), 'Backup restored');
                  }}
                />
              </label>
            </div>
          </div>
          <div className="card">
            <h2>Demo data</h2>
            <p className="small muted">Adds two technicians, some stock and three sample complaints so you can try the workflow.</p>
            <button disabled={busy} onClick={() => run(() => loadDemoData(db, current), 'Demo data loaded')}>
              Load demo data
            </button>
          </div>
          <div className="card">
            <h2>Reset</h2>
            <p className="small muted">Deletes everything on this device. Download a backup first.</p>
            <button
              className="danger"
              onClick={() => {
                if (prompt('Type DELETE to erase all data on this device') !== 'DELETE') return;
                run(async () => {
                  await db.transaction('rw', db.tables, async () => {
                    for (const t of db.tables) await t.clear();
                  });
                  await seedIfEmpty(db);
                }, 'All data erased');
              }}
            >
              Erase all data
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
