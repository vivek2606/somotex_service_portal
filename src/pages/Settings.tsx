import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, useSyncState, useUser } from '../auth/AuthContext';
import { ChangePasswordForm } from '../auth/AuthScreens';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, useAction, useToast } from '../components/ui';
import { ROLE_LABEL } from '../db/auth';
import { db, runtime, SYNCED_TABLES, type SyncedTable } from '../db/db';
import { hasDemoData, loadDemoData, purgeLocalDemo } from '../db/demo';
import { seedIfEmpty } from '../db/seed';
import { supabase } from '../cloud/supabase';
import { useLiveQuery } from 'dexie-react-hooks';
import { exportAll, importAll } from '../db/service';
import { saveSettings, type AppSettings } from '../db/settings';
import { REFRIGERANTS, type JobType, type Priority } from '../db/types';
import { btuToHpLabel, DEFAULT_NORMS } from '../lib/consumption';
import { ANY, type WarrantyRule } from '../lib/warranty';
import { downloadText } from '../lib/csv';

export default function Settings() {
  const current = useSettings();
  const { run, busy } = useAction();
  const [s, setS] = useState<AppSettings>(current);
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: 'account', label: 'My account' },
    ...(runtime.cloud ? [{ key: 'sync', label: 'Sync' }] : []),
    ...(can('editSettings')
      ? [
          { key: 'general', label: 'General' },
          { key: 'norms', label: 'Gas norms' },
          { key: 'data', label: 'Data & backup' },
        ]
      : []),
  ];
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'account';
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
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
        {dirty && can('editSettings') && (
          <button className="primary" onClick={save} disabled={busy}>
            Save changes
          </button>
        )}
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'account' && <AccountTab />}
      {tab === 'sync' && <SyncTab />}

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
                Country dialling code <span className="hint">for WhatsApp / SMS, e.g. 234</span>
                <input value={s.countryCode} onChange={(e) => setS({ ...s, countryCode: e.target.value.replace(/\D/g, '') })} />
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
            <h2>Warranty periods</h2>
            <p className="small muted">
              Warranty is worked out from the invoice date. The most specific rule applies: brand and product, then brand, then
              product, then the general rule. Add a compressor period where the brand gives a longer compressor warranty.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Product</th>
                    <th className="num">Months</th>
                    <th className="num">Compressor months</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {s.warrantyRules.map((r, i) => {
                    const setRule = (patch: Partial<WarrantyRule>) =>
                      setS({ ...s, warrantyRules: s.warrantyRules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                    return (
                      <tr key={i}>
                        <td>
                          <select value={r.brand} onChange={(e) => setRule({ brand: e.target.value })}>
                            <option value={ANY}>Any brand</option>
                            {s.brands.map((b) => (
                              <option key={b.name}>{b.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select value={r.category} onChange={(e) => setRule({ category: e.target.value as WarrantyRule['category'] })}>
                            <option value={ANY}>Any product</option>
                            {s.categories.map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input type="number" min="0" value={r.months} onChange={(e) => setRule({ months: num(e.target.value) })} />
                        </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            value={r.compressorMonths ?? ''}
                            placeholder="—"
                            onChange={(e) => setRule({ compressorMonths: e.target.value === '' ? undefined : num(e.target.value) })}
                          />
                        </td>
                        <td className="right">
                          {!(r.brand === ANY && r.category === ANY) && (
                            <button className="sm" onClick={() => setS({ ...s, warrantyRules: s.warrantyRules.filter((_, j) => j !== i) })}>
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button
              style={{ marginTop: 10 }}
              onClick={() => setS({ ...s, warrantyRules: [...s.warrantyRules, { brand: s.brands[0]?.name ?? ANY, category: ANY, months: 12 }] })}
            >
              Add rule
            </button>
          </div>

          <div className="card">
            <h2>Branches</h2>
            <label className="field">
              One per line. Complaints and technicians are assigned to a branch.
              <textarea
                rows={7}
                value={s.branches.join('\n')}
                onChange={(e) => setS({ ...s, branches: e.target.value.split('\n') })}
                onBlur={() => setS({ ...s, branches: s.branches.map((b) => b.trim()).filter(Boolean) })}
              />
            </label>
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
            <h2>Typical nameplate charge: wall split ACs</h2>
            <p className="small muted">
              Used when the complaint has no nameplate charge. 1 HP = 9,000 BTU/h, 1.5 HP = 12,000, 2 HP = 18,000. These figures are
              tentative; replace them with the charges printed on your Midea, AUX, Tamashi and Bruhm outdoor-unit labels.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Size</th>
                    <th>Type</th>
                    <th>Refrigerant</th>
                    <th className="num">Charge (g)</th>
                  </tr>
                </thead>
                <tbody>
                  {n.typicalSplitCharges.map((row, i) => (
                    <tr key={`${row.btu}-${row.inverter}-${row.refrigerant}`}>
                      <td>
                        {btuToHpLabel(row.btu)} ({row.btu.toLocaleString()} BTU/h)
                      </td>
                      <td>{row.inverter ? 'Inverter' : 'Non-inverter'}</td>
                      <td>{row.refrigerant}</td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          value={row.grams}
                          onChange={(e) =>
                            setNorms({
                              typicalSplitCharges: n.typicalSplitCharges.map((x, j) => (j === i ? { ...x, grams: num(e.target.value) } : x)),
                            })
                          }
                        />
                      </td>
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
              {runtime.cloud
                ? 'Data is kept on the shared server and copied to each signed-in computer. The server keeps its own backups; you can also download a copy of everything here.'
                : 'All data is stored on this device, and the app works offline. Download a backup regularly and keep it safe.'}
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
              {!runtime.cloud && <label className="btn">
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
              </label>}
            </div>
          </div>
          <DemoDataCard />
          {!runtime.cloud && <div className="card">
            <h2>Reset</h2>
            <p className="small muted">Deletes everything on this device. Download a backup first.</p>
            <button
              className="danger"
              onClick={() => {
                if (prompt('Type DELETE to erase all data on this device') !== 'DELETE') return;
                run(async () => {
                  // Accounts are kept so people can still sign in.
                  await db.transaction('rw', SYNCED_TABLES.map((t) => db.table(t)), async () => {
                    for (const t of SYNCED_TABLES) await db.table(t).clear();
                  });
                  await seedIfEmpty(db);
                }, 'All data erased');
              }}
            >
              Erase all data
            </button>
          </div>}
        </div>
      )}
    </div>
  );
}

function AccountTab() {
  const user = useUser();
  const toast = useToast();
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h2>Signed in as</h2>
        <dl className="kv">
          <dt>Name</dt>
          <dd>{user.displayName}</dd>
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{ROLE_LABEL[user.role]}</dd>
        </dl>
        <p className="small muted" style={{ marginTop: 10 }}>
          Your name and email are recorded on every complaint, call, stock movement and closure you make.
        </p>
        <p className="small muted">
          App version {__APP_VERSION__} · {runtime.cloud ? 'shared database' : 'single-device mode'}
        </p>
      </div>
      <div className="card">
        <h2>Change password</h2>
        <ChangePasswordForm user={user} onDone={() => toast('Password changed')} />
      </div>
    </div>
  );
}

const TABLE_LABEL: Record<SyncedTable, string> = {
  settings: 'Settings',
  technicians: 'Technician',
  items: 'Item',
  customers: 'Customer',
  complaints: 'Complaint',
  movements: 'Stock movement',
  logs: 'Timeline entry',
  alerts: 'Alert',
  cylinders: 'Cylinder',
  cylinderMoves: 'Cylinder weighing',
  requests: 'Branch request',
};

function SyncTab() {
  const { sync } = useAuth();
  const state = useSyncState();
  const { run, busy } = useAction();
  const [rejected, setRejected] = useState<{ table: SyncedTable; row: Record<string, unknown> }[]>([]);
  useEffect(() => {
    void (async () => {
      const out: { table: SyncedTable; row: Record<string, unknown> }[] = [];
      for (const t of SYNCED_TABLES) {
        for (const row of await db.table(t).where('_dirty').equals(2).toArray()) out.push({ table: t, row });
      }
      setRejected(out);
    })();
  }, [state?.rejected]);

  if (!sync || !state) return <Empty>Sync starts after sign-in.</Empty>;
  return (
    <div className="stack">
      <div className="card">
        <h2>Status</h2>
        <dl className="kv">
          <dt>Connection</dt>
          <dd>{state.status === 'offline' ? 'Offline' : state.status === 'error' ? 'Problem' : 'Connected'}</dd>
          <dt>Last synced</dt>
          <dd>{state.lastSyncAt ? fmtDateTime(state.lastSyncAt) : 'Not yet'}</dd>
          <dt>Waiting to upload</dt>
          <dd>{state.pending}</dd>
          {state.message && (
            <>
              <dt>Last message</dt>
              <dd>{state.message}</dd>
            </>
          )}
        </dl>
        <button style={{ marginTop: 12 }} disabled={busy} onClick={() => run(() => sync.syncNow(), 'Synced')}>
          Sync now
        </button>
      </div>
      <div className="card">
        <h2>Changes refused by the server</h2>
        <p className="small muted">
          For example, stock issued on this computer when another computer had already issued the last of it. Check the details and
          discard the change here, then redo it correctly if needed.
        </p>
        {rejected.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          rejected.map(({ table, row }) => (
            <div key={`${table}-${row.id as string}`} className="alert-box critical">
              <div className="row between">
                <strong>{TABLE_LABEL[table]}</strong>
                <button
                  className="sm"
                  disabled={busy}
                  onClick={() => run(() => sync.discardRejected(table, row.id as string), 'Change discarded')}
                >
                  Discard
                </button>
              </div>
              <div className="small">{row._syncError as string}</div>
              {table === 'movements' && (
                <div className="small">
                  {row.kind as string} of {Math.abs(row.qty as number)} ·{' '}
                  {row.complaintId ? <Link to={`/complaints/${row.complaintId as string}`}>open job</Link> : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <div className="card">
        <h2>Refresh this computer's copy</h2>
        <p className="small muted">Downloads everything from the server again. Changes waiting to upload are kept.</p>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await db.meta.filter((m) => m.key.startsWith('pull:')).delete();
              await sync.syncNow();
            }, 'Data refreshed')
          }
        >
          Re-download data
        </button>
      </div>
    </div>
  );
}

function DemoDataCard() {
  const settings = useSettings();
  const { sync } = useAuth();
  const { run, busy } = useAction();
  const loaded = useLiveQuery(() => hasDemoData(db), []);

  const load = () => {
    const where = runtime.cloud ? 'the shared database. Everyone signed in on any computer will see it' : 'this computer';
    if (!confirm(`This adds about two months of sample customers, complaints, stock and gas use to ${where}. Remove it again before real use. Continue?`)) return;
    run(async () => {
      await loadDemoData(db, settings);
      await sync?.syncNow();
    }, 'Demo data loaded');
  };

  const remove = () => {
    if (!confirm('Remove all demo records? Real records you have entered are not affected.')) return;
    run(async () => {
      if (runtime.cloud) {
        await sync?.syncNow();
        const { error } = await supabase!.rpc('purge_demo_data');
        if (error) throw new Error(error.message);
      }
      await purgeLocalDemo(db);
      await sync?.syncNow();
    }, 'Demo data removed');
  };

  return (
    <div className="card">
      <h2>Demo data</h2>
      <p className="small muted">
        About two months of realistic sample activity: customers across all brands and products, complaints at every stage (some
        overdue), technicians, stock receipts, gas issued against budgets, over-budget and repeat-leak alerts, customer calls and
        ratings. Use it to try the workflow and see the reports; every demo record is marked so it can be removed in one step.
        Items without a unit cost are given example prices. Check them under Inventory before going live.
      </p>
      {busy ? (
        <button disabled>Working… please keep this page open</button>
      ) : loaded ? (
        <button className="danger" onClick={remove}>
          Remove demo data
        </button>
      ) : (
        <button onClick={load}>Load demo data</button>
      )}
    </div>
  );
}
