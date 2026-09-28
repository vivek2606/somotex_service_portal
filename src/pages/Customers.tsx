import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Loading } from '../components/ui';
import { db } from '../db/db';
import { isOpen } from '../db/service';

export default function Customers() {
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const [limit, setLimit] = useState(50);
  const data = useLiveQuery(async () => {
    const [customers, complaints] = await Promise.all([db.customers.orderBy('name').toArray(), db.complaints.toArray()]);
    const stats = new Map<string, { total: number; open: number }>();
    for (const c of complaints) {
      const s = stats.get(c.customerId) ?? { total: 0, open: 0 };
      s.total++;
      if (isOpen(c)) s.open++;
      stats.set(c.customerId, s);
    }
    return { customers, stats };
  }, []);

  const list = useMemo(() => {
    if (!data) return undefined;
    if (!query) return data.customers;
    const digits = query.replace(/\D/g, '');
    return data.customers.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        c.city?.toLowerCase().includes(query) ||
        (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)),
    );
  }, [data, query]);

  return (
    <div>
      <div className="topbar">
        <h1>Customers</h1>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search name, phone or city…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty>No customers yet. They're added when you register a complaint.</Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th className="hide-mobile">City</th>
                  <th className="num">Complaints</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, limit).map((c) => {
                  const s = data!.stats.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/customers/${c.id}`}>{c.name}</Link>
                        <div className="small muted">{c.type}</div>
                      </td>
                      <td>{c.phone}</td>
                      <td className="hide-mobile">{c.city}</td>
                      <td className="num">
                        {s?.total ?? 0}
                        {!!s?.open && <span className="badge primary" style={{ marginLeft: 6 }}>{s.open} open</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.length > limit && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button onClick={() => setLimit(limit + 50)}>Show more</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
