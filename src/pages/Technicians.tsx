import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../components/SettingsContext';
import { Empty, Loading, useAction } from '../components/ui';
import { db, newId } from '../db/db';
import { isOpen } from '../db/service';
import type { Technician } from '../db/types';

const blank: Omit<Technician, 'id'> = { name: '', phone: '', skills: '', active: true, branch: '' };

export default function Technicians() {
  const { run, busy } = useAction();
  const { can } = useAuth();
  const settings = useSettings();
  const [f, setF] = useState(blank);
  const [editId, setEditId] = useState<string>();
  const data = useLiveQuery(async () => {
    const [techs, complaints] = await Promise.all([db.technicians.orderBy('name').toArray(), db.complaints.toArray()]);
    const load = new Map<string, { open: number; closed: number }>();
    for (const c of complaints) {
      if (!c.technicianId) continue;
      const l = load.get(c.technicianId) ?? { open: 0, closed: 0 };
      if (isOpen(c)) l.open++;
      else if (c.status === 'Closed') l.closed++;
      load.set(c.technicianId, l);
    }
    return { techs, load };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!f.name.trim()) throw new Error('Enter a name');
      if (editId) await db.technicians.update(editId, { ...f, branch: f.branch || undefined });
      else await db.technicians.add({ ...f, id: newId(), name: f.name.trim(), branch: f.branch || undefined });
      setF(blank);
      setEditId(undefined);
    }, 'Saved');
  };

  if (!data) return <Loading />;
  return (
    <div>
      <div className="topbar">
        <h1>Technicians</h1>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ padding: 0 }}>
          {data.techs.length === 0 ? (
            <Empty>No technicians yet. Add your team.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Open</th>
                    <th className="num">Closed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.techs.map((t) => (
                    <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                      <td>
                        {t.name}
                        <div className="small muted">
                          <a href={`tel:${t.phone}`}>{t.phone}</a> {t.branch && `· ${t.branch}`} {t.skills && `· ${t.skills}`}
                        </div>
                      </td>
                      <td className="num">
                        <Link to="/complaints?status=open">{data.load.get(t.id)?.open ?? 0}</Link>
                      </td>
                      <td className="num">{data.load.get(t.id)?.closed ?? 0}</td>
                      <td className="right">
                        {can('manageTechnicians') && <button
                          className="sm"
                          onClick={() => {
                            setEditId(t.id);
                            setF({ name: t.name, phone: t.phone, skills: t.skills, active: t.active, branch: t.branch ?? '' });
                          }}
                        >
                          Edit
                        </button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {can('manageTechnicians') ? (
        <form className="card" onSubmit={submit}>
          <h2>{editId ? 'Edit technician' : 'Add technician'}</h2>
          <div className="form-grid">
            <label className="field">
              Name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label className="field">
              Phone
              <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </label>
            <label className="field span-all">
              Branch
              <select value={f.branch ?? ''} onChange={(e) => setF({ ...f, branch: e.target.value })}>
                <option value="">Any branch</option>
                {settings.branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label className="field span-all">
              Skills
              <input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder="e.g. VRF, split AC, fridges" />
            </label>
            <label className="field inline">
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
              Active
            </label>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy}>
              {editId ? 'Save' : 'Add'}
            </button>
            {editId && (
              <button
                type="button"
                onClick={() => {
                  setEditId(undefined);
                  setF(blank);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        ) : (
          <div className="card small muted">Technicians are added and edited by the Service Head.</div>
        )}
      </div>
    </div>
  );
}
