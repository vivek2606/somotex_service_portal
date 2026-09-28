import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, Loading, SeverityBadge, useAction } from '../components/ui';
import { db } from '../db/db';
import { acknowledgeAlert } from '../db/service';

export default function Alerts() {
  const settings = useSettings();
  const { run } = useAction();
  const { can } = useAuth();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const data = useLiveQuery(async () => {
    const alerts = (await db.alerts.toArray())
      .filter((a) => !a.cleared && (show === 'all' || !a.acknowledged))
      .sort((a, b) => b.at.localeCompare(a.at));
    const complaints = new Map((await db.complaints.bulkGet([...new Set(alerts.map((a) => a.complaintId))])).filter(Boolean).map((c) => [c!.id, c!]));
    const technicians = new Map((await db.technicians.toArray()).map((t) => [t.id, t.name]));
    return { alerts, complaints, technicians };
  }, [show]);

  if (!data) return <Loading />;
  return (
    <div>
      <div className="topbar">
        <h1>Consumption alerts</h1>
        <span className="spacer" />
        <select value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')} style={{ width: 'auto' }}>
          <option value="open">Needs review</option>
          <option value="all">All, including reviewed</option>
        </select>
      </div>
      <p className="muted small">
        Raised automatically when gas or consumables used on a job exceed the budget for the unit's capacity and the work done
        (tolerance {settings.norms.tolerancePct}%, critical above {settings.norms.criticalPct}%). Also raised for the wrong refrigerant,
        gas used on jobs that shouldn't need it, and units re-charged within {settings.norms.repeatWindowDays} days.
      </p>
      {data.alerts.length === 0 ? (
        <div className="card">
          <Empty>No alerts to review.</Empty>
        </div>
      ) : (
        data.alerts.map((a) => {
          const c = data.complaints.get(a.complaintId);
          return (
            <div key={a.id} className={`alert-box ${a.severity}`}>
              <div className="row between">
                <div className="row">
                  <SeverityBadge severity={a.severity} />
                  <Link to={`/complaints/${a.complaintId}`}>{c?.ticketNo}</Link>
                  <span className="small muted">
                    {c && `${c.equipment.brand} ${c.equipment.category}`} · {a.technicianId ? data.technicians.get(a.technicianId) : 'unassigned'} ·{' '}
                    {fmtDateTime(a.at)}
                  </span>
                </div>
                {a.acknowledged ? (
                  <span className="small">Reviewed: {a.ackNote || '—'}</span>
                ) : !can('reviewAlerts') ? (
                  <span className="small muted">Awaiting Service Head review</span>
                ) : (
                  <button
                    className="sm"
                    onClick={() => {
                      const note = prompt('Review note (why was this acceptable, or what action was taken?)');
                      if (note !== null) run(() => acknowledgeAlert(db, settings, a.id, note), 'Alert reviewed');
                    }}
                  >
                    Mark reviewed
                  </button>
                )}
              </div>
              <p style={{ margin: '6px 0 0' }}>{a.message}</p>
            </div>
          );
        })
      )}
    </div>
  );
}
