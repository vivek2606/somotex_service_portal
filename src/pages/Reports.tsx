import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDate, fmtDuration, fmtMoney, Loading } from '../components/ui';
import { db } from '../db/db';
import type { Complaint } from '../db/types';
import { causeById } from '../lib/diagnosis';
import { downloadText, toCsv } from '../lib/csv';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function countBy<T>(list: T[], key: (t: T) => string) {
  const m = new Map<string, number>();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <Empty>No data.</Empty>
      ) : (
        rows.slice(0, 10).map(([k, v]) => (
          <div key={k} style={{ marginBottom: 8 }}>
            <div className="row between small">
              <span>{k}</span>
              <strong>{v}</strong>
            </div>
            <div className="bar">
              <span style={{ width: `${(v / max) * 100}%` }} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export default function Reports() {
  const settings = useSettings();
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(isoDay(new Date()));

  const data = useLiveQuery(async () => {
    const start = new Date(from).toISOString();
    const end = new Date(new Date(to).getTime() + 86400000).toISOString();
    const closed = await db.complaints.where('closedAt').between(start, end).toArray();
    const registered = await db.complaints.where('createdAt').between(start, end).count();
    const customers = new Map((await db.customers.bulkGet([...new Set(closed.map((c) => c.customerId))])).filter(Boolean).map((c) => [c!.id!, c!]));
    const technicians = new Map((await db.technicians.toArray()).map((t) => [t.id!, t.name]));
    const items = new Map((await db.items.toArray()).map((i) => [i.id!, i]));
    const cost = new Map<number, number>();
    for (const c of closed) {
      const moves = await db.movements.where('complaintId').equals(c.id!).toArray();
      cost.set(c.id!, moves.reduce((t, m) => t + -m.qty * (items.get(m.itemId)?.unitCost ?? 0), 0));
    }
    return { closed: closed.sort((a, b) => b.closedAt!.localeCompare(a.closedAt!)), registered, customers, technicians, cost };
  }, [from, to]);

  if (!data) return <Loading />;
  const { closed, customers, technicians, cost } = data;
  const tat = (c: Complaint) => new Date(c.resolvedAt ?? c.closedAt!).getTime() - new Date(c.createdAt).getTime();
  const inSla = (c: Complaint) => (c.resolvedAt ?? c.closedAt!) <= c.dueAt;
  const avgTat = closed.length ? closed.reduce((t, c) => t + tat(c), 0) / closed.length : 0;
  const slaPct = closed.length ? Math.round((closed.filter(inSla).length / closed.length) * 100) : 0;
  const rated = closed.filter((c) => c.customerFeedback);
  const avgRating = rated.length ? rated.reduce((t, c) => t + c.customerFeedback!, 0) / rated.length : undefined;
  const causeName = (c: Complaint) => (c.confirmedCauseId ? causeById(c.confirmedCauseId)?.name ?? 'Other' : 'Not recorded');
  const inHouse = new Set(settings.brands.filter((b) => b.inHouse).map((b) => b.name));
  const inHouseClosed = closed.filter((c) => inHouse.has(c.equipment.brand));

  const exportCsv = () =>
    downloadText(
      `closures-${from}-to-${to}.csv`,
      toCsv([
        ['Ticket', 'Logged', 'Closed', 'Customer', 'Phone', 'Brand', 'Category', 'Model', 'Serial', 'Warranty', 'Complaint', 'Customer said', 'Job type', 'Confirmed cause', 'Resolution', 'Technician', 'TAT hours', 'Within target', 'Rating', 'Material cost', 'Service charge'],
        ...closed.map((c) => {
          const cu = customers.get(c.customerId);
          return [
            c.ticketNo, c.createdAt, c.closedAt, cu?.name, cu?.phone, c.equipment.brand, c.equipment.category, c.equipment.model,
            c.equipment.serialNo, c.equipment.warranty, c.complaintType, c.customerStatement, c.jobType, causeName(c), c.resolution,
            technicians.get(c.technicianId ?? -1), (tat(c) / 3600000).toFixed(1), inSla(c) ? 'Yes' : 'No', c.customerFeedback,
            Math.round(cost.get(c.id!) ?? 0), c.serviceCharge,
          ];
        }),
      ]),
    );

  return (
    <div>
      <div className="topbar">
        <h1>Reports</h1>
        <span className="spacer" />
        <label className="field inline">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field inline">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={exportCsv} disabled={!closed.length}>
          Export CSV
        </button>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">Registered</div>
          <div className="value">{data.registered}</div>
        </div>
        <div className="card kpi ok">
          <div className="label">Closed</div>
          <div className="value">{closed.length}</div>
        </div>
        <div className="card kpi">
          <div className="label">Avg. time to resolve</div>
          <div className="value">{closed.length ? fmtDuration(avgTat) : '—'}</div>
        </div>
        <div className={`card kpi ${slaPct < 80 ? 'warn' : 'ok'}`}>
          <div className="label">Resolved within target</div>
          <div className="value">{closed.length ? `${slaPct}%` : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">Customer rating</div>
          <div className="value">{avgRating ? `${avgRating.toFixed(1)} ★` : '—'}</div>
        </div>
      </div>

      <div className="grid cols-3">
        <Breakdown title="Closures by brand" rows={countBy(closed, (c) => c.equipment.brand)} />
        <Breakdown title="By product" rows={countBy(closed, (c) => c.equipment.category)} />
        <Breakdown title="By technician" rows={countBy(closed, (c) => technicians.get(c.technicianId ?? -1) ?? 'Unassigned')} />
        <Breakdown title="Confirmed causes" rows={countBy(closed, causeName)} />
        <Breakdown title="Job types" rows={countBy(closed, (c) => c.jobType ?? 'Not recorded')} />
        <Breakdown
          title={`In-house brands (${[...inHouse].join(', ')}): failures by model`}
          rows={countBy(inHouseClosed, (c) => `${c.equipment.brand} ${c.equipment.model || c.equipment.category} · ${causeName(c)}`)}
        />
      </div>

      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>Closure history</h2>
        {closed.length === 0 ? (
          <Empty>No complaints closed in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th className="hide-mobile">Product</th>
                  <th className="hide-mobile">Cause / resolution</th>
                  <th className="hide-mobile">Technician</th>
                  <th className="num">Time</th>
                  <th className="num hide-mobile">Material cost</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">
                      <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link>
                      <div className="small muted">{fmtDate(c.closedAt)}</div>
                    </td>
                    <td>{customers.get(c.customerId)?.name}</td>
                    <td className="hide-mobile">
                      {c.equipment.brand} {c.equipment.category}
                      <div className="small muted">{c.equipment.model}</div>
                    </td>
                    <td className="hide-mobile">
                      {causeName(c)}
                      <div className="small muted">{c.resolution}</div>
                    </td>
                    <td className="hide-mobile">{technicians.get(c.technicianId ?? -1) ?? '—'}</td>
                    <td className="num nowrap">
                      {fmtDuration(tat(c))}
                      {!inSla(c) && (
                        <div>
                          <span className="badge bad">late</span>
                        </div>
                      )}
                    </td>
                    <td className="num hide-mobile">{fmtMoney(cost.get(c.id!) ?? 0, settings.currency)}</td>
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
