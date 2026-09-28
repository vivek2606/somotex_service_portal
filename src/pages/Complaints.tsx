import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, fmtDateTime, Loading, PriorityBadge, StatusBadge } from '../components/ui';
import { db } from '../db/db';
import { isOpen, OPEN_STATUSES } from '../db/service';
import type { ComplaintStatus } from '../db/types';

const STATUSES: ComplaintStatus[] = [...OPEN_STATUSES, 'Resolved', 'Closed', 'Cancelled'];
const PAGE = 50;

export default function Complaints() {
  const settings = useSettings();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [tech, setTech] = useState('');
  const [branch, setBranch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const query = useDeferredValue(q.trim().toLowerCase());

  const complaints = useLiveQuery(async () => {
    const coll =
      status === 'open' || status === 'overdue'
        ? db.complaints.where('status').anyOf(OPEN_STATUSES)
        : status === 'all'
          ? db.complaints.toCollection()
          : db.complaints.where('status').equals(status);
    return (await coll.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [status]);
  const customers = useLiveQuery(async () => new Map((await db.customers.toArray()).map((c) => [c.id, c])), []);
  const technicians = useLiveQuery(() => db.technicians.toArray(), []);

  const filtered = useMemo(() => {
    if (!complaints || !customers) return undefined;
    const now = new Date().toISOString();
    return complaints.filter((c) => {
      if (status === 'overdue' && !(isOpen(c) && c.dueAt < now)) return false;
      if (brand && c.equipment.brand !== brand) return false;
      if (category && c.equipment.category !== category) return false;
      if (tech && (c.technicianId ?? '') !== tech) return false;
      if (branch && c.branch !== branch) return false;
      if (!query) return true;
      const cust = customers.get(c.customerId);
      return [c.ticketNo, cust?.name, cust?.phone, c.equipment.serialNo, c.equipment.model, c.complaintType, c.callerName]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(query));
    });
  }, [complaints, customers, status, brand, category, tech, branch, query]);

  const techName = (id?: string) => technicians?.find((t) => t.id === id)?.name ?? '—';
  const now = new Date().toISOString();

  return (
    <div>
      <div className="topbar">
        <h1>Complaints</h1>
        <span className="spacer" />
        <Link to="/complaints/new" className="btn primary">
          New complaint
        </Link>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search ticket, customer, phone, serial, model…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setParams({ status: e.target.value })}>
          <option value="open">Open</option>
          <option value="overdue">Overdue</option>
          <option value="all">All</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {settings.branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <select value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">All brands</option>
          {settings.brands.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All products</option>
          {settings.categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={tech} onChange={(e) => setTech(e.target.value)}>
          <option value="">All technicians</option>
          {technicians?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {!filtered ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <div className="card">
          <Empty>No complaints match.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap hide-mobile">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Product</th>
                  <th>Problem</th>
                  <th>Technician</th>
                  <th>Status</th>
                  <th>Logged / by</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((c) => {
                  const cust = customers!.get(c.customerId);
                  const late = isOpen(c) && c.dueAt < now;
                  return (
                    <tr key={c.id} className="clickable" onClick={() => navigate(`/complaints/${c.id}`)}>
                      <td className="nowrap">
                        <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link>
                        <div>
                          <PriorityBadge priority={c.priority} />
                        </div>
                      </td>
                      <td>
                        {cust?.name}
                        <div className="small muted">{cust?.phone}</div>
                      </td>
                      <td>
                        {c.equipment.brand} {c.equipment.category}
                        <div className="small muted">
                          {c.equipment.model}
                          {c.branch && ` · ${c.branch}`}
                        </div>
                      </td>
                      <td>{c.complaintType}</td>
                      <td>{techName(c.technicianId)}</td>
                      <td>
                        <StatusBadge status={c.status} />
                        {late && (
                          <div>
                            <span className="badge bad">Overdue</span>
                          </div>
                        )}
                      </td>
                      <td className="nowrap small">
                        {fmtDateTime(c.createdAt)}
                        <div className="muted">{c.loggedByEmail ?? c.loggedBy}</div>
                        {c.closedByEmail && <div className="muted">closed: {c.closedByEmail}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="list-cards">
            {filtered.slice(0, limit).map((c) => {
              const cust = customers!.get(c.customerId);
              const late = isOpen(c) && c.dueAt < now;
              return (
                <Link key={c.id} to={`/complaints/${c.id}`} className="item">
                  <div className="row between">
                    <strong>{c.ticketNo}</strong>
                    <span className="row">
                      {late && <span className="badge bad">Overdue</span>}
                      <StatusBadge status={c.status} />
                    </span>
                  </div>
                  <div>
                    {cust?.name} · {c.equipment.brand} {c.equipment.category}
                  </div>
                  <div className="small muted">
                    {c.complaintType} · {techName(c.technicianId)} · {fmtDateTime(c.createdAt)}
                  </div>
                </Link>
              );
            })}
          </div>
          {filtered.length > limit && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button onClick={() => setLimit(limit + PAGE)}>Show more ({filtered.length - limit} left)</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
