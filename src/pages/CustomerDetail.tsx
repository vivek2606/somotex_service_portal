import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, fmtDate, Loading, StatusBadge, useAction } from '../components/ui';
import { db } from '../db/db';
import type { Customer } from '../db/types';

export default function CustomerDetail() {
  const id = useParams().id ?? '';
  const customer = useLiveQuery(() => db.customers.get(id), [id]);
  const complaints = useLiveQuery(() => db.complaints.where('customerId').equals(id).reverse().sortBy('createdAt'), [id]);
  const { run, busy } = useAction();
  const [f, setF] = useState<Customer | undefined>();
  useEffect(() => setF(customer), [customer]);

  if (!customer || !f) return <Loading />;

  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() => db.customers.update(id, { ...f }), 'Customer saved');
  };

  return (
    <div>
      <div className="topbar">
        <h1>{customer.name}</h1>
        <span className="spacer" />
        <Link to={`/complaints/new?customer=${id}`} className="btn primary">
          New complaint for this customer
        </Link>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={save}>
          <h2>Details</h2>
          <div className="form-grid">
            <label className="field">
              Name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label className="field">
              Phone
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </label>
            <label className="field">
              Alternate phone
              <input value={f.altPhone ?? ''} onChange={(e) => setF({ ...f, altPhone: e.target.value })} />
            </label>
            <label className="field">
              Email
              <input value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </label>
            <label className="field span-all">
              Address
              <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            </label>
            <label className="field">
              City
              <input value={f.city ?? ''} onChange={(e) => setF({ ...f, city: e.target.value })} />
            </label>
            <label className="field">
              Type
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Customer['type'] })}>
                <option>Individual</option>
                <option>Business</option>
                <option>Dealer</option>
              </select>
            </label>
          </div>
          <button type="submit" className="primary" disabled={busy} style={{ marginTop: 12 }}>
            Save
          </button>
        </form>
        <div className="card">
          <h2>Service history</h2>
          {!complaints?.length ? (
            <Empty>No complaints yet.</Empty>
          ) : (
            <ul className="timeline">
              {complaints.map((c) => (
                <li key={c.id}>
                  <div className="row between">
                    <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link>
                    <StatusBadge status={c.status} />
                  </div>
                  <div>
                    {c.equipment.brand} {c.equipment.category} {c.equipment.model} · {c.complaintType}
                  </div>
                  <div className="meta">
                    {fmtDate(c.createdAt)}
                    {c.equipment.serialNo && <> · S/N {c.equipment.serialNo}</>}
                    {c.resolution && <> · {c.resolution}</>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
