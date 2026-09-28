import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { db } from '../db/db';
import { escalationMessage, markEscalated, pendingEscalations, type Escalation } from '../db/escalation';
import { OPEN_STATUSES } from '../db/service';
import { appLink } from '../lib/links';
import { toInternational } from '../lib/phone';
import { useSettings } from './SettingsContext';
import { fmtDuration, PriorityBadge, useAction } from './ui';

function usePending() {
  const settings = useSettings();
  return useLiveQuery(async () => {
    const open = await db.complaints.where('status').anyOf(OPEN_STATUSES).toArray();
    return pendingEscalations(open, settings, new Date());
  }, [settings]);
}

/** Dashboard card: late and urgent jobs to send to the Service Head. */
export function EscalationCard() {
  const settings = useSettings();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const pending = usePending();
  const lookups = useLiveQuery(async () => {
    const ids = [...new Set((pending ?? []).map((e) => e.c.customerId))];
    const customers = (await db.customers.bulkGet(ids)).filter((c) => !!c);
    const techs = await db.technicians.toArray();
    return { customers: new Map(customers.map((c) => [c!.id, c!])), technicians: new Map(techs.map((t) => [t.id, t.name])) };
  }, [pending]);
  if (!pending?.length || !lookups) return null;

  const { phone, email } = settings.escalation;
  const message = (list: Escalation[]) =>
    escalationMessage(list, lookups.customers, lookups.technicians, settings.companyName, (c) => appLink(`/complaints/${c.id}`), new Date());
  const isHead = user?.role === 'head';
  const wa = (list: Escalation[]) => `https://wa.me/${toInternational(phone, settings.countryCode)}?text=${encodeURIComponent(message(list))}`;
  const mail = (list: Escalation[]) =>
    `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`${settings.companyName} service escalation: ${list.length} complaint(s)`)}&body=${encodeURIComponent(message(list))}`;
  const mark = (list: Escalation[], via: string) => run(() => markEscalated(db, settings, list, via));

  return (
    <div className="card" style={{ marginBottom: 14, borderColor: 'var(--bad)' }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Escalate to the Service Head ({pending.length})</h2>
        <div className="row">
          {phone && (
            <a className="btn sm primary" href={wa(pending)} target="_blank" rel="noreferrer" onClick={() => mark(pending, 'WhatsApp')}>
              WhatsApp all
            </a>
          )}
          {email && (
            <a className="btn sm" href={mail(pending)} onClick={() => mark(pending, 'email')}>
              Email all
            </a>
          )}
          {isHead && (
            <button className="sm" disabled={busy} onClick={() => mark(pending, 'the Service Head (seen in the app)')}>
              Mark all seen
            </button>
          )}
        </div>
      </div>
      {!phone && !email && (
        <p className="small muted" style={{ marginTop: 6 }}>
          Add the Service Head’s WhatsApp number and email under Settings → General → Escalation to send these with one click.
        </p>
      )}
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <tbody>
            {pending.slice(0, 8).map((e) => (
              <tr key={e.c.id + e.reason}>
                <td>
                  <Link to={`/complaints/${e.c.id}`}>{e.c.ticketNo}</Link>
                  <div className="small muted">
                    {e.c.branch} · {lookups.customers.get(e.c.customerId)?.name}
                  </div>
                </td>
                <td>
                  {e.reason === 'urgent' ? (
                    <PriorityBadge priority={e.c.priority} />
                  ) : (
                    <span className="badge bad">overdue {fmtDuration(Date.now() - Date.parse(e.c.dueAt))}</span>
                  )}
                </td>
                <td className="right">
                  {phone && (
                    <a className="btn sm" href={wa([e])} target="_blank" rel="noreferrer" onClick={() => mark([e], 'WhatsApp')}>
                      WhatsApp
                    </a>
                  )}{' '}
                  {email && (
                    <a className="btn sm" href={mail([e])} onClick={() => mark([e], 'email')}>
                      Email
                    </a>
                  )}{' '}
                  {isHead && (
                    <button className="sm" disabled={busy} onClick={() => mark([e], 'the Service Head (seen in the app)')}>
                      Seen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pending.length > 8 && <p className="small muted">…and {pending.length - 8} more (included in “all”).</p>}
    </div>
  );
}

const SEEN_KEY = 'somotex.escalationsNotified';

/**
 * On the Service Head's computer, shows a desktop notification when a job
 * becomes late or urgent, if they have allowed notifications.
 */
export function EscalationNotifier() {
  const { user } = useAuth();
  const pending = usePending();
  useEffect(() => {
    if (user?.role !== 'head' || !pending?.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
    } catch {
      /* storage unavailable */
    }
    const fresh = pending.filter((e) => !seen.includes(`${e.c.id}:${e.reason}`));
    if (!fresh.length) return;
    const n = new Notification(`${fresh.length} complaint${fresh.length === 1 ? '' : 's'} need attention`, {
      body: fresh
        .slice(0, 4)
        .map((e) => `${e.c.ticketNo}: ${e.reason === 'urgent' ? `${e.c.priority} priority` : 'overdue'}`)
        .join('\n'),
      tag: 'escalations',
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = '#/';
    };
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((e) => `${e.c.id}:${e.reason}`)].slice(-500)));
    } catch {
      /* storage unavailable */
    }
  }, [pending, user]);
  return null;
}
