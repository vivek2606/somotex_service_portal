import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { fmtDuration, fmtMoney, fmtNum, Loading, SeverityBadge, StatusBadge } from '../components/ui';
import { db } from '../db/db';
import { gasJobStats, isOpen, OPEN_STATUSES } from '../db/service';

export default function Dashboard() {
  const settings = useSettings();
  const data = useLiveQuery(async () => {
    const now = new Date();
    const nowIso = now.toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const open = await db.complaints.where('status').anyOf(OPEN_STATUSES).toArray();
    const closedMonth = await db.complaints.where('closedAt').aboveOrEqual(monthStart).toArray();
    const items = await db.items.filter((i) => i.active).toArray();
    const low = items.filter((i) => i.stock <= i.reorderLevel).sort((a, b) => a.stock / (a.reorderLevel || 1) - b.stock / (b.reorderLevel || 1));
    const alerts = await db.alerts.filter((a) => !a.acknowledged && a.severity !== 'info').reverse().sortBy('at');
    const gas = await gasJobStats(db, settings, monthStart);
    const tats = closedMonth.filter((c) => c.resolvedAt).map((c) => new Date(c.resolvedAt!).getTime() - new Date(c.createdAt).getTime());
    const excessCost = gas.reduce(
      (t, s) => (s.expected !== undefined && s.actual > s.expected ? t + (s.actual - s.expected) * s.unitCost : t),
      0,
    );
    const gasCost = gas.reduce((t, s) => t + s.actual * s.unitCost, 0);
    const complaints = new Map(
      (await db.complaints.bulkGet([...new Set(alerts.map((a) => a.complaintId))])).filter(Boolean).map((c) => [c!.id!, c!]),
    );
    return {
      open,
      overdue: open.filter((c) => c.dueAt < nowIso),
      unassigned: open.filter((c) => !c.technicianId),
      awaitingParts: open.filter((c) => c.status === 'Awaiting Parts'),
      closedMonth: closedMonth.length,
      avgTat: tats.length ? tats.reduce((a, b) => a + b, 0) / tats.length : undefined,
      low,
      alerts: alerts.slice(0, 6).map((a) => ({ ...a, ticket: complaints.get(a.complaintId)?.ticketNo })),
      alertCount: alerts.length,
      gasCost,
      excessCost,
      urgent: open
        .filter((c) => c.priority === 'Critical' || c.dueAt < nowIso)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .slice(0, 6),
    };
  }, [settings]);

  if (!data) return <Loading />;

  return (
    <div>
      <div className="topbar">
        <h1>Dashboard</h1>
        <span className="spacer" />
        <Link to="/complaints/new" className="btn primary">
          New complaint
        </Link>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <Link to="/complaints?status=open" className="card kpi">
          <div className="label">Open complaints</div>
          <div className="value">{data.open.length}</div>
        </Link>
        <Link to="/complaints?status=overdue" className={`card kpi ${data.overdue.length ? 'bad' : 'ok'}`}>
          <div className="label">Overdue (past target)</div>
          <div className="value">{data.overdue.length}</div>
        </Link>
        <Link to="/complaints?status=Registered" className={`card kpi ${data.unassigned.length ? 'warn' : ''}`}>
          <div className="label">Not yet assigned</div>
          <div className="value">{data.unassigned.length}</div>
        </Link>
        <Link to="/complaints?status=Awaiting Parts" className="card kpi">
          <div className="label">Awaiting parts</div>
          <div className="value">{data.awaitingParts.length}</div>
        </Link>
        <Link to="/reports" className="card kpi ok">
          <div className="label">Closed this month</div>
          <div className="value">{data.closedMonth}</div>
          <div className="small muted">{data.avgTat !== undefined ? `avg ${fmtDuration(data.avgTat)} to resolve` : ' '}</div>
        </Link>
        <Link to="/gas" className={`card kpi ${data.excessCost > 0 ? 'warn' : ''}`}>
          <div className="label">Gas cost this month</div>
          <div className="value" style={{ fontSize: '1.3rem' }}>
            {fmtMoney(data.gasCost, settings.currency)}
          </div>
          <div className="small muted">{fmtMoney(data.excessCost, settings.currency)} above budget</div>
        </Link>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="row between">
            <h2>Needs attention</h2>
            <Link to="/complaints?status=overdue" className="small">
              All overdue
            </Link>
          </div>
          {data.urgent.length === 0 ? (
            <p className="muted">Nothing is critical or overdue.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {data.urgent.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link>
                        <div className="small muted">
                          {c.equipment.brand} {c.equipment.category}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="right small" style={{ color: isOpen(c) && c.dueAt < new Date().toISOString() ? 'var(--bad)' : undefined }}>
                        {c.dueAt < new Date().toISOString() ? 'overdue ' : 'due in '}
                        {fmtDuration(new Date(c.dueAt).getTime() - Date.now())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row between">
            <h2>Gas consumption alerts</h2>
            <Link to="/alerts" className="small">
              All ({data.alertCount})
            </Link>
          </div>
          {data.alerts.length === 0 ? (
            <p className="muted">No open alerts. Gas use is within norms.</p>
          ) : (
            data.alerts.map((a) => (
              <div key={a.id} className={`alert-box ${a.severity}`}>
                <div className="row between">
                  <Link to={`/complaints/${a.complaintId}`}>{a.ticket}</Link>
                  <SeverityBadge severity={a.severity} />
                </div>
                <div className="small">{a.message}</div>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <div className="row between">
            <h2>Low stock</h2>
            <Link to="/inventory?low=1" className="small">
              Inventory
            </Link>
          </div>
          {data.low.length === 0 ? (
            <p className="muted">All items are above their reorder level.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {data.low.slice(0, 8).map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={`/inventory/${i.id}`}>{i.name}</Link>
                        <div className="small muted">{i.type}</div>
                      </td>
                      <td className="num">
                        <strong style={{ color: i.stock <= 0 ? 'var(--bad)' : 'var(--warn)' }}>
                          {fmtNum(i.stock, 3)} {i.unit}
                        </strong>
                        <div className="small muted">
                          reorder at {fmtNum(i.reorderLevel)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
