import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDate, fmtMoney, fmtNum, Loading } from '../components/ui';
import { db } from '../db/db';
import { loadJobFacts, loadRefrigerantOutflows } from '../db/insightsData';
import { gasJobStats } from '../db/service';
import { toGrams } from '../lib/consumption';
import { causeById } from '../lib/diagnosis';
import {
  branchScorecard,
  DEFAULT_SEASON,
  leakHotspots,
  powerAnalysis,
  productQuality,
  repeatCustomers,
  seasonalForecast,
  technicianRanking,
  VOLTAGE_BAND,
  type JobFacts,
} from '../lib/insights';

const TABS = [
  { key: 'leaks', label: 'Gas leak hotspots' },
  { key: 'quality', label: 'In-house brand quality' },
  { key: 'power', label: 'Power-related failures' },
  { key: 'forecast', label: 'Refrigerant forecast' },
  { key: 'branches', label: 'Branch scorecard' },
  { key: 'technicians', label: 'Technician gas ranking' },
  { key: 'customers', label: 'Repeat customers' },
];

const PERIODS = [
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 6 months', days: 180 },
  { key: '365', label: 'Last 12 months', days: 365 },
  { key: 'all', label: 'All time', days: 0 },
];

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

export default function Insights() {
  const settings = useSettings();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'leaks';
  const [period, setPeriod] = useState('365');

  const data = useLiveQuery(async () => {
    const days = PERIODS.find((p) => p.key === period)!.days;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : undefined;
    const [facts, technicians, gas] = await Promise.all([
      loadJobFacts(db, settings, since),
      db.technicians.toArray(),
      gasJobStats(db, settings, since),
    ]);
    return { facts, technicians: new Map(technicians.map((t) => [t.id, t.name])), gas };
  }, [period, settings]);

  return (
    <div>
      <div className="topbar">
        <h1>Insights</h1>
        <span className="spacer" />
        {tab !== 'forecast' && (
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 'auto' }}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setParams({ tab: t.key }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'forecast' ? (
        <ForecastTab />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {tab === 'leaks' && <LeaksTab facts={data.facts} />}
          {tab === 'quality' && <QualityTab facts={data.facts} />}
          {tab === 'power' && <PowerTab facts={data.facts} />}
          {tab === 'branches' && <BranchTab facts={data.facts} />}
          {tab === 'technicians' && <TechnicianTab gas={data.gas} technicians={data.technicians} tolerancePct={settings.norms.tolerancePct} currency={settings.currency} />}
          {tab === 'customers' && <CustomersTab facts={data.facts} />}
        </>
      )}
    </div>
  );
}

function Bars({ rows, unit = '' }: { rows: { label: string; value: number; note?: string }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <Empty>No data.</Empty>;
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} style={{ marginBottom: 8 }}>
          <div className="row between small">
            <span>{r.label}</span>
            <strong>
              {fmtNum(r.value)}
              {unit}
              {r.note && <span className="muted"> · {r.note}</span>}
            </strong>
          </div>
          <div className="bar">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ----------------------------------------------------------------- leaks

function LeaksTab({ facts }: { facts: JobFacts[] }) {
  const r = leakHotspots(facts);
  if (!r.leakJobs) return <div className="card"><Empty>No leak repairs or gas top-ups in this period.</Empty></div>;
  return (
    <>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">Leak repairs and top-ups</div>
          <div className="value">{r.leakJobs}</div>
        </div>
        <div className={`card kpi ${r.repeatUnits.length ? 'bad' : 'ok'}`}>
          <div className="label">Units leaking more than once</div>
          <div className="value">{r.repeatUnits.length}</div>
        </div>
        <div className={`card kpi ${r.unrecorded ? 'warn' : 'ok'}`}>
          <div className="label">Leak point not recorded</div>
          <div className="value">{r.unrecorded}</div>
          <div className="small muted">record it under Job &amp; closure</div>
        </div>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>Where the leaks are</h2>
          <Bars rows={r.byPoint.map((p) => ({ label: p.point, value: p.jobs, note: `${fmtNum(p.refrigerantKg)} kg gas` }))} unit=" jobs" />
          <p className="small muted">Gas on a job with several leak points is shared between them.</p>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <h2 style={{ padding: '16px 16px 0' }}>By model</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Jobs</th>
                  <th className="num">Units</th>
                  <th>Main leak points</th>
                  <th className="num">Gas</th>
                </tr>
              </thead>
              <tbody>
                {r.byModel.slice(0, 15).map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td className="num">{m.jobs}</td>
                    <td className="num">{m.units}</td>
                    <td className="small">{m.points.map((p) => `${p.name} (${p.count})`).join(', ') || '—'}</td>
                    <td className="num">{fmtNum(m.refrigerantKg)} kg</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {r.repeatUnits.length > 0 && (
        <div className="card" style={{ marginTop: 14, padding: 0 }}>
          <h2 style={{ padding: '16px 16px 0' }}>Units that keep losing gas</h2>
          <p className="small muted" style={{ padding: '0 16px' }}>
            Send a senior technician with a nitrogen pressure test and leak detector. Topping up without finding the leak loses the gas again.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Jobs</th>
                  <th>Leak points found</th>
                  <th className="num">Gas used</th>
                </tr>
              </thead>
              <tbody>
                {r.repeatUnits.map((u) => (
                  <tr key={u.serialNo + u.model}>
                    <td>
                      {u.model}
                      <div className="small muted">S/N {u.serialNo}</div>
                    </td>
                    <td>
                      {u.jobs.map((c) => (
                        <Link key={c.id} to={`/complaints/${c.id}`} style={{ marginRight: 8 }}>
                          {c.ticketNo}
                        </Link>
                      ))}
                    </td>
                    <td className="small">{u.points.join(', ') || 'not recorded'}</td>
                    <td className="num">{fmtNum(u.refrigerantKg)} kg</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- quality

function QualityTab({ facts }: { facts: JobFacts[] }) {
  const settings = useSettings();
  const inHouse = settings.brands.filter((b) => b.inHouse).map((b) => b.name);
  const [brand, setBrand] = useState('');
  const [batchChars, setBatchChars] = useState(6);
  const brands = new Set(brand ? [brand] : inHouse);
  const q = productQuality(facts, brands, batchChars, (id) => causeById(id)?.name);
  const allBrands = settings.brands.map((b) => b.name);
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ width: 'auto' }}>
          <option value="">In-house brands ({inHouse.join(', ')})</option>
          {allBrands.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <label className="field inline small">
          Batch = first
          <select value={batchChars} onChange={(e) => setBatchChars(Number(e.target.value))} style={{ width: 'auto' }}>
            {[3, 4, 5, 6, 7, 8, 10].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          characters of the serial number
        </label>
      </div>
      {!q.failures ? (
        <div className="card">
          <Empty>No failures recorded for these brands in this period.</Empty>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0 }}>
            <h2 style={{ padding: '16px 16px 0' }}>Failures by model</h2>
            <p className="small muted" style={{ padding: '0 16px' }}>
              Excludes installations and maintenance visits. “Months to first failure” runs from the invoice date to the unit’s first complaint.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Failures</th>
                    <th className="num">Units</th>
                    <th className="num">Months to first failure (median)</th>
                    <th className="num">Failed within 6 months</th>
                    <th>Parts replaced</th>
                    <th className="hide-mobile">Confirmed causes</th>
                  </tr>
                </thead>
                <tbody>
                  {q.byModel.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td className="num">{m.failures}</td>
                      <td className="num">{m.units}</td>
                      <td className="num">{m.medianMonths !== undefined ? fmtNum(m.medianMonths, 1) : '—'}</td>
                      <td className="num" style={{ color: m.early ? 'var(--bad)' : undefined }}>
                        {m.early}
                      </td>
                      <td className="small">{m.parts.map((p) => `${p.name} (${fmtNum(p.count)})`).join(', ') || '—'}</td>
                      <td className="small hide-mobile">{m.causes.map((p) => `${p.name} (${p.count})`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
            <div className="card">
              <h2>Age of the unit at first failure</h2>
              <Bars rows={q.byAge.map((a) => ({ label: a.bucket, value: a.units }))} unit=" units" />
              {q.unknownAge > 0 && <p className="small muted">{q.unknownAge} unit(s) have no invoice date.</p>}
            </div>
            <div className="card">
              <h2>Parts replaced</h2>
              <Bars rows={q.byPart.map((p) => ({ label: p.name, value: p.count }))} />
            </div>
          </div>
          <div className="card" style={{ marginTop: 14, padding: 0 }}>
            <h2 style={{ padding: '16px 16px 0' }}>By serial-number batch</h2>
            <p className="small muted" style={{ padding: '0 16px' }}>
              A batch with many early failures points to a production or shipment problem. Take this list to the factory or supplier.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Batch</th>
                    <th>Models</th>
                    <th className="num">Failures</th>
                    <th className="num">Units</th>
                    <th className="num">Within 6 months</th>
                  </tr>
                </thead>
                <tbody>
                  {q.byBatch.slice(0, 25).map((b) => (
                    <tr key={b.brand + b.batch}>
                      <td>{b.brand}</td>
                      <td className="mono">{b.batch}…</td>
                      <td className="small">{b.models.join(', ')}</td>
                      <td className="num">{b.failures}</td>
                      <td className="num">{b.units}</td>
                      <td className="num" style={{ color: b.early ? 'var(--bad)' : undefined }}>
                        {b.early}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ power

function PowerTab({ facts }: { facts: JobFacts[] }) {
  const p = powerAnalysis(facts);
  const rate = (x: { jobs: number; electrical: number }) => (x.jobs ? Math.round((x.electrical / x.jobs) * 100) : undefined);
  const withRate = rate(p.withStabiliser);
  const withoutRate = rate(p.withoutStabiliser);
  return (
    <>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">PCB, power supply and compressor failures</div>
          <div className="value">{p.electrical}</div>
        </div>
        <div className="card kpi">
          <div className="label">Jobs with power readings</div>
          <div className="value">{p.recorded}</div>
          <div className="small muted">voltage or stabiliser recorded</div>
        </div>
        <div className={`card kpi ${withoutRate !== undefined && withRate !== undefined && withoutRate > withRate ? 'bad' : ''}`}>
          <div className="label">Electrical failures: no stabiliser</div>
          <div className="value">{withoutRate !== undefined ? `${withoutRate}%` : '—'}</div>
          <div className="small muted">of {p.withoutStabiliser.jobs} jobs</div>
        </div>
        <div className="card kpi ok">
          <div className="label">Electrical failures: with stabiliser</div>
          <div className="value">{withRate !== undefined ? `${withRate}%` : '—'}</div>
          <div className="small muted">of {p.withStabiliser.jobs} jobs</div>
        </div>
      </div>
      {withoutRate !== undefined && withRate !== undefined && withoutRate > withRate && (
        <div className="alert-box warning" style={{ marginBottom: 14 }}>
          Units without a stabiliser had {withoutRate}% electrical failures against {withRate}% for protected units. Recommend a stabiliser (AVS) at
          installation and on every electrical repair.
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>By area</h2>
        <p className="small muted" style={{ padding: '0 16px' }}>
          Normal supply is 230 V; readings below {VOLTAGE_BAND.low} V or above {VOLTAGE_BAND.high} V count as bad power. The area is the customer’s city.
        </p>
        {!p.byArea.length ? (
          <Empty>No electrical failures or power readings in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th className="num">Electrical failures</th>
                  <th className="num">…without stabiliser</th>
                  <th className="num">…on generator</th>
                  <th className="num">Bad voltage readings</th>
                  <th className="num">Average voltage</th>
                </tr>
              </thead>
              <tbody>
                {p.byArea.map((a) => (
                  <tr key={a.area}>
                    <td>{a.area}</td>
                    <td className="num">{a.electrical}</td>
                    <td className="num">{a.noStabiliser}</td>
                    <td className="num">{a.generator}</td>
                    <td className="num" style={{ color: a.badVoltage ? 'var(--bad)' : undefined }}>
                      {a.badVoltage} / {a.recorded}
                    </td>
                    <td className="num">{a.avgVoltage ? `${a.avgVoltage} V` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>In-warranty electrical failures to review</h2>
        <p className="small muted" style={{ padding: '0 16px' }}>
          Failures where the unit had bad voltage, no stabiliser or ran on a generator. Check the warranty terms before accepting the claim as a
          product fault.
        </p>
        {!p.warrantyReview.length ? (
          <Empty>None in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Unit</th>
                  <th>Power conditions</th>
                </tr>
              </thead>
              <tbody>
                {p.warrantyReview.map(({ c, reasons }) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link>
                      <div className="small muted">{fmtDate(c.createdAt)}</div>
                    </td>
                    <td>
                      {c.equipment.brand} {c.equipment.model}
                      <div className="small muted">{c.jobType}</div>
                    </td>
                    <td className="small">{reasons.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------- forecast

function ForecastTab() {
  const data = useLiveQuery(async () => {
    const { outflows, stockKg } = await loadRefrigerantOutflows(db);
    return seasonalForecast(outflows, stockKg, new Date());
  }, []);
  if (!data) return <Loading />;
  if (!data.length) return <div className="card"><Empty>No refrigerant items yet.</Empty></div>;
  const monthsShort = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  return (
    <>
      <p className="small muted">
        Refrigerant leaving the Lagos store each month (to jobs and branches) and the next three months’ likely need. With a year of history the
        forecast uses the same months last year, adjusted for the recent trend. Before that it uses the recent rate and the typical season (
        {DEFAULT_SEASON.map((f, i) => `${monthsShort[i]} ${f}`).join(', ')}). Pale bar: this month so far; striped: forecast.
      </p>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {data.map((f) => {
          const all = [...f.history.map((h) => ({ ...h, future: false })), ...f.next.map((n) => ({ ...n, future: true }))];
          const max = Math.max(0.1, ...all.map((m) => m.kg));
          const need = f.next.reduce((t, m) => t + m.kg, 0);
          return (
            <div key={f.refrigerant} className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>{f.refrigerant}</h2>
                <span className="small muted">
                  {f.basis === 'last-year' ? 'based on last year' : f.basis === 'seasonal-pattern' ? 'based on recent use and season' : 'no use yet'}
                </span>
              </div>
              <div className="colchart" aria-label={`${f.refrigerant} monthly use`}>
                {all.map((m, i) => (
                  <div
                    key={m.month}
                    className={m.future ? 'future' : i === f.history.length - 1 ? 'partial' : ''}
                    title={`${monthLabel(m.month)}: ${fmtNum(m.kg)} kg${m.future ? ' (forecast)' : i === f.history.length - 1 ? ' (this month so far)' : ''}`}
                  >
                    <span style={{ height: `${(m.kg / max) * 100}%` }} />
                    <small>{monthLabel(m.month).split(' ')[0].slice(0, 1)}</small>
                  </div>
                ))}
              </div>
              <dl className="kv small" style={{ marginTop: 10 }}>
                <dt>Next 3 months</dt>
                <dd>
                  {f.next.map((n) => `${monthLabel(n.month)} ${fmtNum(n.kg)} kg`).join(' · ')} (total {fmtNum(need)} kg)
                </dd>
                <dt>In stock</dt>
                <dd>{fmtNum(f.stockKg)} kg</dd>
                <dt>Order now</dt>
                <dd>
                  <strong style={{ color: f.orderKg > 0 ? 'var(--warn)' : 'var(--ok)' }}>{f.orderKg > 0 ? `${f.orderKg} kg` : 'Nothing: stock covers it'}</strong>
                  {f.orderKg > 0 && <span className="muted"> (need + 10% margin − stock)</span>}
                </dd>
              </dl>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- branches

function BranchTab({ facts }: { facts: JobFacts[] }) {
  const settings = useSettings();
  const closed = facts.filter((f) => f.c.status === 'Closed' && f.c.closedAt);
  const rows = branchScorecard(closed, settings.branches);
  const best = (key: keyof (typeof rows)[number], high: boolean) => {
    const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
    return vals.length ? (high ? Math.max(...vals) : Math.min(...vals)) : undefined;
  };
  const cell = (v: number | undefined, key: keyof (typeof rows)[number], high: boolean, fmt: (n: number) => string) => (
    <td className="num" style={{ fontWeight: v !== undefined && v === best(key, high) && rows.length > 1 ? 700 : undefined, color: v !== undefined && v === best(key, high) && rows.length > 1 ? 'var(--ok)' : undefined }}>
      {v === undefined ? '—' : fmt(v)}
    </td>
  );
  return (
    <div className="card" style={{ padding: 0 }}>
      <h2 style={{ padding: '16px 16px 0' }}>Branch scorecard</h2>
      <p className="small muted" style={{ padding: '0 16px' }}>
        Closed jobs in the period. First-time fix: closed without waiting for parts and the unit didn’t come back within 30 days. The best figure in
        each column is in green.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Branch</th>
              <th className="num">Closed</th>
              <th className="num">Avg. time to resolve</th>
              <th className="num">Within target</th>
              <th className="num">First-time fix</th>
              <th className="num">Came back ≤30 d</th>
              <th className="num">Gas vs budget</th>
              <th className="num">Rating</th>
              <th className="num">Material cost / job</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.branch}>
                <td>{r.branch}</td>
                <td className="num">{r.closed}</td>
                {cell(r.avgHours, 'avgHours', false, (n) => (n < 48 ? `${fmtNum(n, 1)} h` : `${fmtNum(n / 24, 1)} d`))}
                {cell(r.withinTargetPct, 'withinTargetPct', true, (n) => `${n}%`)}
                {cell(r.firstTimeFixPct, 'firstTimeFixPct', true, (n) => `${n}%`)}
                {cell(r.cameBackPct, 'cameBackPct', false, (n) => `${n}%`)}
                {cell(r.gasVsBudgetPct, 'gasVsBudgetPct', false, (n) => `${n}%`)}
                {cell(r.rating, 'rating', true, (n) => `${fmtNum(n, 1)} ★ (${r.ratedJobs})`)}
                {cell(r.costPerJob, 'costPerJob', false, (n) => fmtMoney(n, settings.currency))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- technicians

function TechnicianTab({
  gas,
  technicians,
  tolerancePct,
  currency,
}: {
  gas: Awaited<ReturnType<typeof gasJobStats>>;
  technicians: Map<string, string>;
  tolerancePct: number;
  currency: string;
}) {
  const ref = gas.filter((s) => s.itemType === 'Refrigerant' && s.expected !== undefined);
  const g = (s: (typeof ref)[number], v: number) => toGrams(v, s.unit) ?? 0;
  const rows = technicianRanking(
    ref.map((s) => ({ technicianId: s.technicianId, budgetG: g(s, s.expected!), actualG: g(s, s.actual) })),
    tolerancePct,
  );
  // Excess cost per technician across refrigerants, at each item's cost.
  const cost = new Map<string, number>();
  for (const s of ref) {
    if (!s.technicianId) continue;
    cost.set(s.technicianId, (cost.get(s.technicianId) ?? 0) + Math.max(0, s.actual - s.expected!) * s.unitCost);
  }
  if (!rows.length) return <div className="card"><Empty>No refrigerant jobs with a budget in this period.</Empty></div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <h2 style={{ padding: '16px 16px 0' }}>Technician gas ranking</h2>
      <p className="small muted" style={{ padding: '0 16px' }}>
        Refrigerant used as a share of each job’s budget. The budget already allows for unit size, job type and pipe length, so a technician
        doing big VRF jobs is compared fairly with one doing small splits. Ranked only with at least 3 jobs. Over budget means more than{' '}
        {tolerancePct}% above.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Technician</th>
              <th className="num">Jobs</th>
              <th className="num">Avg. budget per job</th>
              <th className="num">Used vs budget</th>
              <th className="num">Jobs over budget</th>
              <th className="num">Excess gas</th>
              <th className="num">Excess cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tone = r.ratio > 1 + tolerancePct / 100 ? 'var(--bad)' : r.ratio > 1 ? 'var(--warn)' : 'var(--ok)';
              return (
                <tr key={r.technicianId}>
                  <td>{r.rank ?? <span className="muted small">too few</span>}</td>
                  <td>{technicians.get(r.technicianId) ?? 'Unknown'}</td>
                  <td className="num">{r.jobs}</td>
                  <td className="num">{fmtNum(r.avgBudgetG / 1000, 2)} kg</td>
                  <td className="num" style={{ color: tone, fontWeight: 600 }}>
                    {Math.round(r.ratio * 100)}%
                  </td>
                  <td className="num">
                    {r.overJobs} ({Math.round((r.overJobs / r.jobs) * 100)}%)
                  </td>
                  <td className="num">{fmtNum(r.excessG / 1000, 2)} kg</td>
                  <td className="num">{fmtMoney(cost.get(r.technicianId) ?? 0, currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- customers

function CustomersTab({ facts }: { facts: JobFacts[] }) {
  const [min, setMin] = useState(3);
  const rows = repeatCustomers(facts, min);
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="field inline small">
          Customers with at least
          <select value={min} onChange={(e) => setMin(Number(e.target.value))} style={{ width: 'auto' }}>
            {[2, 3, 4, 5, 8].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          complaints in the period (installations and maintenance not counted)
        </label>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {!rows.length ? (
          <Empty>No customer has that many complaints in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Complaints</th>
                  <th className="num">Units</th>
                  <th className="num">Open</th>
                  <th>Most common issue</th>
                  <th className="hide-mobile">Worst unit</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.customer.id}>
                    <td>
                      <Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link>
                      <div className="small muted">
                        {r.customer.type} · {r.customer.city ?? ''} · last {fmtDate(r.lastAt)}
                      </div>
                    </td>
                    <td className="num">{r.complaints}</td>
                    <td className="num">{r.units}</td>
                    <td className="num">{r.open}</td>
                    <td className="small">{r.topIssue}</td>
                    <td className="small hide-mobile">
                      {r.worstUnit ? (
                        <>
                          {r.worstUnit.model} ×{r.worstUnit.count}
                          <div className="muted">S/N {r.worstUnit.serialNo || '—'}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {r.flags.map((f) => (
                        <span key={f} className={`badge ${f === 'AMC candidate' ? 'primary' : 'warn'}`} style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }}>
                          {f}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
