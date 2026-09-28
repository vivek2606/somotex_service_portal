import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth, useUser } from '../auth/AuthContext';
import type { StaffAccount } from '../auth/backend';
import { Empty, fmtDateTime, Loading, useAction } from '../components/ui';
import { ROLE_LABEL, validatePassword, type Role } from '../db/auth';

/** A readable temporary password for the Service Head to pass on. */
function tempPassword() {
  const words = ['Mango', 'Lake', 'Baobab', 'Cedar', 'River', 'Falcon', 'Maize', 'Zebra', 'Kudu', 'Sable'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}${pick()}${(crypto.getRandomValues(new Uint32Array(1))[0] % 900) + 100}`;
}

export default function Users() {
  const { backend } = useAuth();
  const me = useUser();
  const { run, busy } = useAction();
  const [staff, setStaff] = useState<StaffAccount[]>();
  const [error, setError] = useState('');
  const [f, setF] = useState({ displayName: '', email: '', role: 'executive' as Role, password: tempPassword() });
  const [issued, setIssued] = useState<{ email: string; password: string }>();

  const load = useCallback(() => {
    backend
      .listStaff()
      .then((s) => {
        setStaff(s);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [backend]);
  useEffect(load, [load]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const err = validatePassword(f.password);
      if (err) throw new Error(err);
      await backend.createStaff(me, { ...f, mustChangePassword: true });
      setIssued({ email: f.email.trim().toLowerCase(), password: f.password });
      setF({ displayName: '', email: '', role: 'executive', password: tempPassword() });
      load();
    }, 'Account created');
  };

  const reset = (a: StaffAccount) => {
    const password = tempPassword();
    if (!confirm(`Reset the password for ${a.displayName}? They will be given a temporary password and asked to choose a new one.`)) return;
    run(async () => {
      await backend.resetPassword(me, a.id, password);
      setIssued({ email: a.email, password });
      load();
    }, 'Password reset');
  };

  const update = (a: StaffAccount, patch: Partial<Pick<StaffAccount, 'displayName' | 'role' | 'active'>>) =>
    run(async () => {
      await backend.updateStaff(me, a, patch);
      load();
    }, 'Account updated');

  return (
    <div>
      <div className="topbar">
        <h1>Users</h1>
      </div>
      <p className="muted small">
        The Service Head manages accounts. Helpdesk executives can register, update and close any complaint, assign technicians and
        issue stock. Settings, technicians, the item catalogue, stock counts, alert reviews and re-opening closed complaints are
        for the Service Head. {backend.mode === 'local' && 'Accounts in single-device mode exist on this computer only.'}
      </p>

      {issued && (
        <div className="alert-box info" style={{ marginBottom: 14 }}>
          <strong>Give these sign-in details to the person:</strong>
          <div style={{ fontFamily: 'monospace', margin: '6px 0' }}>
            Email: {issued.email}
            <br />
            Temporary password: {issued.password}
          </div>
          <span className="small">They'll be asked to choose their own password when they first sign in. This won't be shown again.</span>
          <div>
            <button className="sm" style={{ marginTop: 8 }} onClick={() => setIssued(undefined)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ padding: 0 }}>
          {error ? (
            <p className="error" style={{ padding: 16 }}>
              {error}
            </p>
          ) : !staff ? (
            <Loading />
          ) : staff.length === 0 ? (
            <Empty>No accounts.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((a) => (
                    <tr key={a.id} style={{ opacity: a.active ? 1 : 0.55 }}>
                      <td>
                        <strong>{a.displayName}</strong>
                        {a.id === me.id && <span className="badge primary" style={{ marginLeft: 6 }}>you</span>}
                        <div className="small muted">{a.email}</div>
                        <div className="small muted">
                          {!a.active ? 'Disabled' : a.mustChangePassword ? 'Waiting for first sign-in' : a.lastLoginAt ? `Last sign-in ${fmtDateTime(a.lastLoginAt)}` : ''}
                        </div>
                      </td>
                      <td>
                        <select
                          value={a.role}
                          disabled={busy || a.id === me.id}
                          onChange={(e) => update(a, { role: e.target.value as Role })}
                          style={{ width: 'auto' }}
                        >
                          <option value="executive">{ROLE_LABEL.executive}</option>
                          <option value="head">{ROLE_LABEL.head}</option>
                        </select>
                      </td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="sm" disabled={busy} onClick={() => reset(a)}>
                            Reset password
                          </button>
                          {a.id !== me.id && (
                            <button className={`sm ${a.active ? 'danger' : ''}`} disabled={busy} onClick={() => update(a, { active: !a.active })}>
                              {a.active ? 'Disable' : 'Enable'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <form className="card" onSubmit={create}>
          <h2>Add a person</h2>
          <div className="form-grid">
            <label className="field span-all">
              Name
              <input required value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
            </label>
            <label className="field span-all">
              Email <span className="hint">used to sign in, and shown on the complaints they log and close</span>
              <input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </label>
            <label className="field">
              Role
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
                <option value="executive">{ROLE_LABEL.executive}</option>
                <option value="head">{ROLE_LABEL.head}</option>
              </select>
            </label>
            <label className="field">
              Temporary password
              <input required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </label>
          </div>
          <button type="submit" className="primary" disabled={busy} style={{ marginTop: 12 }}>
            Create account
          </button>
        </form>
      </div>
    </div>
  );
}
