import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtMoney, fmtNum, Loading } from '../components/ui';
import { db } from '../db/db';
import { gasJobStats, type GasJobStat } from '../db/service';
import type { Complaint } from '../db/types';
import { technicianTrends, toGrams } from '../lib/consumption';

const PERIODS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
  { key: 'all', label: 'All time', days: 0 },
];

interface Agg {
  key: string;
  label: string;
  unit: string;
  jobs: number;
  actual: number;
  /** Actual on jobs that have a baseline, to compare like with like. */
  actualWithBaseline: number;
  expected: number;
  excess: number;
  excessCost: number;
  cost: number;
}

function aggregate(stats: GasJobStat[], keyOf: (s: GasJobStat) => string, labelOf: (s: GasJobStat) => string): Agg[] {
  const map = new Map<string, Agg & { jobIds: Set<number> }>();
  for (const s of stats) {
    const key = keyOf(s);
    const a =
      map.get(key) ??
      { key, label: labelOf(s), unit: s.unit, jobs: 0, actual: 0, actualWithBaseline: 0, expected: 0, excess: 0, excessCost: 0, cost: 0, jobIds: new Set<number>() };
    a.jobIds.add(s.complaintId);
    a.actual += s.actual;
    a.cost += s.actual * s.unitCost;
    if (s.expected !== undefined) {
      a.actualWithBaseline += s.actual;
      a.expected += s.expected;
      const ex = Math.max(0, s.actual - s.expected);
      a.excess += ex;
      a.excessCost += ex * s.unitCost;
    }
    map.set(key, a);
  }
  return [...map.values()].map(({ jobIds, ...a }) => ({ ...a, jobs: jobIds.size })).sort((a, b) => b.excessCost - a.excessCost || b.excess - a.excess);
}

const ratio = (a: Agg) => (a.expected > 0 ? a.actualWithBaseline / a.expected : undefined);

function RatioCell({ r, tol }: { r?: number; tol: number }) {
  if (r === undefined) return <td className="num">—</td>;
  const tone = r > 1 + tol ? 'var(--bad)' : r > 1 ? 'var(--warn)' : 'var(--ok)';
  return (
    <td className="num" style={{ color: tone, fontWeight: 600 }}>
      {Math.round(r * 100)}%
    </td>
  );
}

export default function GasEfficiency() {
  const settings = useSettings();
  const [period, setPeriod] = useState('90');
  const tol = settings.norms.tolerancePct / 100;

  const data = useLiveQuery(async () => {
    const days = PERIODS.find((p) => p.key === period)!.days;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : undefined;
    const stats = await gasJobStats(db, settings, since);
    const technicians = new Map((await db.technicians.toArray()).map((t) => [t.id!, t.name]));
    const complaints = new Map(
      (await db.complaints.bulkGet([...new Set(stats.map((s) => s.complaintId))])).filter((c): c is Complaint => !!c).map((c) => [c.id!, c]),
    );
    return { stats, technicians, complaints };
  }, [period, settings]);

  if (!data) return <Loading />;
  const { stats, technicians, complaints } = data;
  const ref = stats.filter((s) => s.itemType === 'Refrigerant');
  const refG = (s: GasJobStat, v: number) => toGrams(v, s.unit) ?? 0;

  const byItem = aggregate(stats, (s) => String(s.itemId), (s) => s.itemName);
  const byJobType = aggregate(ref, (s) => s.jobType ?? 'Not recorded', (s) => s.jobType ?? 'Not recorded');
  const byBrand = aggregate(ref, (s) => s.brand, (s) => s.brand);

  // Technician view in grams across all refrigerants, plus total excess cost across all gases.
  const trends = technicianTrends(
    ref.filter((s) => s.expected !== undefined).map((s) => ({ technicianId: s.technicianId, expectedG: refG(s, s.expected!), actualG: refG(s, s.actual) })),
    settings.norms,
  );
  const techCost = aggregate(stats, (s) => String(s.technicianId ?? 0), (s) => technicians.get(s.technicianId ?? -1) ?? 'Unassigned');
  const techRows = techCost.map((t) => ({ ...t, trend: trends.find((x) => String(x.technicianId) === t.key) }));

  const totalRefG = ref.reduce((t, s) => t + refG(s, s.actual), 0);
  const refWithBase = ref.filter((s) => s.expected !== undefined);
  const refActualBase = refWithBase.reduce((t, s) => t + refG(s, s.actual), 0);
  const refExpected = refWithBase.reduce((t, s) => t + refG(s, s.expected!), 0);
  const refExcessG = refWithBase.reduce((t, s) => t + Math.max(0, refG(s, s.actual) - refG(s, s.expected!)), 0);
  const excessCost = byItem.reduce((t, a) => t + a.excessCost, 0);
  const totalCost = byItem.reduce((t, a) => t + a.cost, 0);

  const refJobs = new Set(ref.map((s) => s.complaintId));
  const topUps = [...refJobs].filter((id) => complaints.get(id)?.jobType === 'Gas Top-up').length;

  // Units charged more than once in the repeat window: the leak was not fixed.
  const bySerial = new Map<string, Complaint[]>();
  for (const id of refJobs) {
    const c = complaints.get(id);
    const sn = c?.equipment.serialNo?.trim();
    if (!c || !sn) continue;
    const k = `${c.equipment.brand}|${sn}`;
    bySerial.set(k, [...(bySerial.get(k) ?? []), c]);
  }
  const windowMs = settings.norms.repeatWindowDays * 86400000;
  const repeats = [...bySerial.values()]
    .map((list) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    .filter((list) => list.some((c, i) => i > 0 && new Date(c.createdAt).getTime() - new Date(list[i - 1].createdAt).getTime() <= windowMs));
  const repeatG = repeats.reduce(
    (t, list) => t + ref.filter((s) => list.slice(1).some((c) => c.id === s.complaintId)).reduce((x, s) => x + refG(s, s.actual), 0),
    0,
  );

  const recoveryJobs = [...refJobs]
    .map((id) => complaints.get(id)!)
    .filter((c) => c && (c.jobType === 'Compressor Replacement' || c.jobType === 'Coil / Pipe Replacement'));
  const recovered = recoveryJobs.filter((c) => (c.recoveredG ?? 0) > 0).length;

  const worst = stats
    .filter((s) => s.expected !== undefined && s.actual > s.expected * (1 + tol))
    .map((s) => ({ ...s, over: s.actual - s.expected!, overCost: (s.actual - s.expected!) * s.unitCost, pct: s.expected ? s.actual / s.expected - 1 : Infinity }))
    .sort((a, b) => b.overCost - a.overCost || b.pct - a.pct)
    .slice(0, 10);

  const tips: string[] = [];
  if (refExpected > 0 && refActualBase / refExpected > 1 + tol)
    tips.push(`Refrigerant use is running at ${Math.round((refActualBase / refExpected) * 100)}% of budget. Weigh gas in with a scale and charge to the nameplate, not by “feel”.`);
  if (refJobs.size >= 5 && topUps / refJobs.size > 0.4)
    tips.push(`${Math.round((topUps / refJobs.size) * 100)}% of refrigerant jobs were top-ups. Leak-test with nitrogen and fix the leak before charging, otherwise the gas is lost again.`);
  if (repeats.length)
    tips.push(`${repeats.length} unit(s) were re-charged within ${settings.norms.repeatWindowDays} days, using ${fmtNum(repeatG / 1000, 2)} kg on repeat visits. Send a senior technician to find these leaks.`);
  for (const t of techRows.filter((t) => t.trend?.flagged))
    tips.push(`${t.label} averages ${Math.round(t.trend!.ratio * 100)}% of the refrigerant budget over ${t.trend!.jobs} jobs. Review their charging method and gas returns.`);
  if (recoveryJobs.length && recovered / recoveryJobs.length < 0.5)
    tips.push(`Refrigerant was recovered on only ${recovered} of ${recoveryJobs.length} compressor/coil replacements. Recover and reuse the gas where it is clean.`);
  const brazing = byItem.filter((a) => stats.find((s) => String(s.itemId) === a.key)?.itemType === 'Brazing Gas' && ratio(a) !== undefined && ratio(a)! > 1 + tol);
  for (const b of brazing)
    tips.push(`${b.label} is at ${Math.round(ratio(b)! * 100)}% of the per-joint norm. Check torch tips, flame setting and cylinder leaks, and close cylinder valves after each job.`);

  return (
    <div>
      <div className="topbar">
        <h1>Gas efficiency</h1>
        <span className="spacer" />
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 'auto' }}>
          {PERIODS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">Refrigerant used</div>
          <div className="value">{fmtNum(totalRefG / 1000, 2)} kg</div>
          <div className="small muted">{refJobs.size} jobs</div>
        </div>
        <div className={`card kpi ${refExpected && refActualBase / refExpected > 1 + tol ? 'bad' : 'ok'}`}>
          <div className="label">Actual vs budget</div>
          <div className="value">{refExpected ? `${Math.round((refActualBase / refExpected) * 100)}%` : '—'}</div>
          <div className="small muted">{fmtNum(refExcessG / 1000, 2)} kg over budget</div>
        </div>
        <div className={`card kpi ${excessCost > 0 ? 'warn' : ''}`}>
          <div className="label">Cost of excess (all gases)</div>
          <div className="value" style={{ fontSize: '1.3rem' }}>
            {fmtMoney(excessCost, settings.currency)}
          </div>
          <div className="small muted">of {fmtMoney(totalCost, settings.currency)} total</div>
        </div>
        <div className={`card kpi ${repeats.length ? 'bad' : 'ok'}`}>
          <div className="label">Repeat-charged units</div>
          <div className="value">{repeats.length}</div>
          <div className="small muted">{fmtNum(repeatG / 1000, 2)} kg on repeats</div>
        </div>
        <div className="card kpi">
          <div className="label">Top-ups / refrigerant jobs</div>
          <div className="value">{refJobs.size ? `${Math.round((topUps / refJobs.size) * 100)}%` : '—'}</div>
        </div>
      </div>

      {tips.length > 0 && (
        <div className="card">
          <h2>How to save gas</h2>
          {tips.map((t) => (
            <div key={t} className="alert-box">
              {t}
            </div>
          ))}
        </div>
      )}

      {stats.length === 0 ? (
        <div className="card">
          <Empty>No gas has been issued to jobs in this period.</Empty>
        </div>
      ) : (
        <>
          <AggTable title="By gas / consumable" rows={byItem} tol={tol} currency={settings.currency} />

          <div className="card">
            <h2>By technician</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Technician</th>
                    <th className="num">Jobs</th>
                    <th className="num">Refrigerant vs budget</th>
                    <th className="num">Excess cost</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {techRows.map((t) => (
                    <tr key={t.key}>
                      <td>{t.label}</td>
                      <td className="num">{t.jobs}</td>
                      <RatioCell r={t.trend?.ratio} tol={tol} />
                      <td className="num">{fmtMoney(t.excessCost, settings.currency)}</td>
                      <td>{t.trend?.flagged && <span className="badge bad">Consistently over</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <AggTable title="Refrigerant by job type" rows={byJobType} tol={tol} currency={settings.currency} compact />
            <AggTable title="Refrigerant by brand" rows={byBrand} tol={tol} currency={settings.currency} compact />
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <h2>Jobs furthest over budget</h2>
            {worst.length === 0 ? (
              <Empty>No job is over budget beyond the {settings.norms.tolerancePct}% tolerance.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Item</th>
                      <th className="num">Used</th>
                      <th className="num">Budget</th>
                      <th className="num">Over</th>
                      <th className="hide-mobile">Technician</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worst.map((w) => (
                      <tr key={`${w.complaintId}-${w.itemId}`}>
                        <td>
                          <Link to={`/complaints/${w.complaintId}`}>{w.ticketNo}</Link>
                          <div className="small muted">{w.jobType ?? 'job type not recorded'}</div>
                        </td>
                        <td>{w.itemName}</td>
                        <td className="num">
                          {fmtNum(w.actual, 3)} {w.unit}
                        </td>
                        <td className="num">{fmtNum(w.expected!, 3)}</td>
                        <td className="num" style={{ color: 'var(--bad)' }}>
                          {Number.isFinite(w.pct) ? `+${Math.round(w.pct * 100)}%` : 'n/a'}
                        </td>
                        <td className="hide-mobile">{technicians.get(w.technicianId ?? -1) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {repeats.length > 0 && (
            <div className="card">
              <h2>Units with repeat gas charging</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th>Jobs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repeats.map((list) => (
                      <tr key={list[0].id}>
                        <td>
                          {list[0].equipment.brand} {list[0].equipment.model}
                          <div className="small muted">S/N {list[0].equipment.serialNo}</div>
                        </td>
                        <td>
                          {list.map((c) => (
                            <Link key={c.id} to={`/complaints/${c.id}`} style={{ marginRight: 8 }}>
                              {c.ticketNo}
                            </Link>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AggTable({ title, rows, tol, currency, compact }: { title: string; rows: Agg[]; tol: number; currency: string; compact?: boolean }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th className="num">Jobs</th>
              <th className="num">Used</th>
              {!compact && <th className="num hide-mobile">Budget</th>}
              <th className="num">vs budget</th>
              <th className="num">Excess cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.key}>
                <td>{a.label}</td>
                <td className="num">{a.jobs}</td>
                <td className="num">
                  {fmtNum(a.actual, 3)} {a.unit}
                </td>
                {!compact && <td className="num hide-mobile">{a.expected ? `${fmtNum(a.expected, 3)} ${a.unit}` : '—'}</td>}
                <RatioCell r={ratio(a)} tol={tol} />
                <td className="num">{fmtMoney(a.excessCost, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
