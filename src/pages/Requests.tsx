import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, fmtNum, Loading, useAction } from '../components/ui';
import { db } from '../db/db';
import { cancelRequest, createRequest, decideRequest, dispatchRequest, receiveRequest } from '../db/requests';
import { OPEN_STATUSES } from '../db/service';
import type { BranchRequest, InventoryItem, RequestLine, RequestStatus } from '../db/types';

const OPEN: RequestStatus[] = ['Requested', 'Approved', 'Dispatched'];
const TONE: Record<RequestStatus, string> = {
  Requested: 'info',
  Approved: 'primary',
  Dispatched: 'warn',
  Received: 'ok',
  Rejected: 'bad',
  Cancelled: '',
};

export default function Requests() {
  const settings = useSettings();
  const [params] = useSearchParams();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [branch, setBranch] = useState('');
  const [creating, setCreating] = useState(!!params.get('complaint'));
  const data = useLiveQuery(async () => {
    const [requests, items] = await Promise.all([db.requests.orderBy('requestedAt').reverse().toArray(), db.items.toArray()]);
    const complaints = new Map(
      (await db.complaints.bulkGet([...new Set(requests.map((r) => r.complaintId).filter((x): x is string => !!x))]))
        .filter(Boolean)
        .map((c) => [c!.id, c!]),
    );
    return { requests, items: new Map(items.map((i) => [i.id, i])), complaints };
  }, []);

  if (!data) return <Loading />;
  const list = data.requests.filter((r) => (show === 'all' || OPEN.includes(r.status)) && (!branch || r.branch === branch));
  const count = (s: RequestStatus) => data.requests.filter((r) => r.status === s).length;

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Branch requests</h1>
          <div className="small muted">Parts and gas sent from the Lagos store to the branches.</div>
        </div>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : 'New request'}
        </button>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className={`card kpi ${count('Requested') ? 'warn' : ''}`}>
          <div className="label">Waiting for approval</div>
          <div className="value">{count('Requested')}</div>
        </div>
        <div className={`card kpi ${count('Approved') ? 'warn' : ''}`}>
          <div className="label">Approved, to dispatch</div>
          <div className="value">{count('Approved')}</div>
        </div>
        <div className="card kpi">
          <div className="label">In transit</div>
          <div className="value">{count('Dispatched')}</div>
        </div>
      </div>

      {creating && <NewRequestForm initialComplaint={params.get('complaint') ?? undefined} onDone={() => setCreating(false)} />}

      <div className="filters">
        <select value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')}>
          <option value="open">Open requests</option>
          <option value="all">All requests</option>
        </select>
        <select value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {settings.branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>

      {list.length === 0 ? (
        <div className="card">
          <Empty>No requests.</Empty>
        </div>
      ) : (
        list.map((r) => <RequestCard key={r.id} r={r} items={data.items} ticket={r.complaintId ? data.complaints.get(r.complaintId)?.ticketNo : undefined} />)
      )}
    </div>
  );
}

function RequestCard({ r, items, ticket }: { r: BranchRequest; items: Map<string, InventoryItem>; ticket?: string }) {
  const settings = useSettings();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const [dispatching, setDispatching] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>(() => Object.fromEntries(r.lines.map((l) => [l.itemId, String(l.qty)])));
  const [waybill, setWaybill] = useState('');
  const [carrier, setCarrier] = useState('');

  const dispatch = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await dispatchRequest(db, settings, r.id, {
        sent: Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, Number(v) || 0])),
        waybill,
        carrier,
      });
      setDispatching(false);
    }, 'Dispatched');
  };

  return (
    <div className="card">
      <div className="row between">
        <div>
          <strong>{r.ref}</strong> <span className={`badge ${TONE[r.status]}`}>{r.status}</span> <span className="badge">{r.branch}</span>
          {r.complaintId && (
            <>
              {' '}
              for <Link to={`/complaints/${r.complaintId}`}>{ticket ?? 'job'}</Link>
            </>
          )}
          <div className="small muted">
            Requested {fmtDateTime(r.requestedAt)} by {r.requestedBy}
            {r.requestedByEmail && ` (${r.requestedByEmail})`}
            {r.reason && ` · ${r.reason}`}
          </div>
        </div>
        <div className="row">
          {r.status === 'Requested' && can('approveRequests') && (
            <>
              <button className="sm primary" disabled={busy} onClick={() => run(() => decideRequest(db, settings, r.id, true), 'Approved')}>
                Approve
              </button>
              <button
                className="sm danger"
                disabled={busy}
                onClick={() => {
                  const note = prompt('Reason for rejecting?');
                  if (note) run(() => decideRequest(db, settings, r.id, false, note), 'Rejected');
                }}
              >
                Reject
              </button>
            </>
          )}
          {r.status === 'Requested' && !can('approveRequests') && <span className="small muted">Awaiting Service Head approval</span>}
          {r.status === 'Approved' && !dispatching && (
            <button className="sm primary" onClick={() => setDispatching(true)}>
              Dispatch
            </button>
          )}
          {r.status === 'Dispatched' && (
            <button
              className="sm primary"
              disabled={busy}
              onClick={() => {
                const note = prompt('Received in good condition? Add a note (optional).', '');
                if (note !== null) run(() => receiveRequest(db, settings, r.id, note), 'Marked received');
              }}
            >
              Mark received
            </button>
          )}
          {(r.status === 'Requested' || r.status === 'Approved') && (
            <button
              className="sm"
              disabled={busy}
              onClick={() => {
                const note = prompt('Why cancel this request?');
                if (note) run(() => cancelRequest(db, settings, r.id, note), 'Cancelled');
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Asked</th>
              <th className="num">{dispatching ? 'Send now' : 'Sent'}</th>
              <th className="num hide-mobile">Lagos stock</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => {
              const it = items.get(l.itemId);
              return (
                <tr key={l.itemId}>
                  <td>{it?.name ?? 'Item'}</td>
                  <td className="num">
                    {fmtNum(l.qty, 3)} {it?.unit}
                  </td>
                  <td className="num">
                    {dispatching ? (
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={sent[l.itemId] ?? ''}
                        onChange={(e) => setSent({ ...sent, [l.itemId]: e.target.value })}
                        style={{ width: 90 }}
                      />
                    ) : l.sentQty !== undefined ? (
                      fmtNum(l.sentQty, 3)
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num hide-mobile" style={{ color: it && it.stock < l.qty ? 'var(--bad)' : undefined }}>
                    {it ? fmtNum(it.stock, 3) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dispatching && (
        <form onSubmit={dispatch} className="row" style={{ marginTop: 8 }}>
          <input placeholder="Waybill no." value={waybill} onChange={(e) => setWaybill(e.target.value)} style={{ flex: '1 1 140px' }} />
          <input placeholder="Carrier / driver" value={carrier} onChange={(e) => setCarrier(e.target.value)} style={{ flex: '1 1 140px' }} />
          <button className="primary" disabled={busy}>
            Confirm dispatch
          </button>
          <button type="button" onClick={() => setDispatching(false)}>
            Back
          </button>
        </form>
      )}

      <div className="small muted" style={{ marginTop: 8 }}>
        {r.decidedAt && `${r.status === 'Rejected' || r.status === 'Cancelled' ? r.status : 'Approved'} ${fmtDateTime(r.decidedAt)} by ${r.decidedBy}${r.decisionNote ? `: ${r.decisionNote}` : ''}. `}
        {r.dispatchedAt && `Dispatched ${fmtDateTime(r.dispatchedAt)} by ${r.dispatchedBy}${r.waybill ? `, waybill ${r.waybill}` : ''}${r.carrier ? ` via ${r.carrier}` : ''}. `}
        {r.receivedAt && `Received ${fmtDateTime(r.receivedAt)} by ${r.receivedBy}${r.receivedNote ? `: ${r.receivedNote}` : ''}.`}
      </div>
    </div>
  );
}

function NewRequestForm({ initialComplaint, onDone }: { initialComplaint?: string; onDone: () => void }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const data = useLiveQuery(async () => {
    const [items, open] = await Promise.all([
      db.items.filter((i) => i.active).sortBy('name'),
      db.complaints.where('status').anyOf(OPEN_STATUSES).toArray(),
    ]);
    return { items, open: open.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }, []);
  const initial = data?.open.find((c) => c.id === initialComplaint);
  const [complaintId, setComplaintId] = useState(initialComplaint ?? '');
  const [branch, setBranch] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<RequestLine[]>([{ itemId: '', qty: 1 }]);
  const job = data?.open.find((c) => c.id === complaintId) ?? initial;
  const effectiveBranch = branch || job?.branch || settings.branches[1] || settings.branches[0] || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await createRequest(db, settings, { branch: effectiveBranch, complaintId: complaintId || undefined, lines, reason });
      onDone();
    }, 'Request sent to Lagos');
  };

  if (!data) return null;
  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}>
      <h2>Request from Lagos store</h2>
      <div className="form-grid">
        <label className="field">
          For job
          <select value={complaintId} onChange={(e) => setComplaintId(e.target.value)}>
            <option value="">No specific job (branch stock)</option>
            {data.open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.ticketNo} · {c.branch ?? '—'} · {c.equipment.brand} {c.equipment.category}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Branch
          <select value={effectiveBranch} onChange={(e) => setBranch(e.target.value)}>
            {settings.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field span-all">
          Reason / note
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. compressor capacitor for SMX job, customer waiting" />
        </label>
      </div>
      <h3 style={{ marginTop: 12 }}>Items</h3>
      {lines.map((l, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <select
            value={l.itemId}
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}
            style={{ flex: '3 1 220px' }}
          >
            <option value="">Choose item…</option>
            {data.items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name} ({fmtNum(it.stock, 3)} {it.unit} in Lagos)
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="any"
            value={l.qty}
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))}
            style={{ flex: '1 1 90px' }}
          />
          {lines.length > 1 && (
            <button type="button" className="sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => setLines([...lines, { itemId: '', qty: 1 }])}>
          Add item
        </button>
        <button className="primary" disabled={busy}>
          Send request
        </button>
      </div>
    </form>
  );
}
