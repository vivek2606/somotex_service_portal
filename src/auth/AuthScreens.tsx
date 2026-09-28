import { useState, type FormEvent, type ReactNode } from 'react';
import type { SessionUser } from '../db/auth';
import { validatePassword } from '../db/auth';
import { backend } from './AuthContext';

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="brand" style={{ padding: '0 0 12px' }}>
          <img src="./icon.svg" alt="" />
          <div>
            Somotex
            <small>Service Portal</small>
          </div>
        </div>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>
        {subtitle && <p className="muted small">{subtitle}</p>}
        {children}
        <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
          Version {__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}

function useSubmit<T>(fn: () => Promise<T>, done: (v: T) => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      done(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export function LoginScreen({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(() => backend.login(email, password), onLogin);
  return (
    <Frame title="Sign in" subtitle="Use the email and password given to you by the Service Head.">
      <form onSubmit={submit} className="stack">
        <label className="field">
          Email
          <input type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="small muted">Forgot your password? Ask the Service Head to reset it.</p>
      </form>
    </Frame>
  );
}

export function SetupScreen({ onDone }: { onDone: (u: SessionUser) => void }) {
  const [f, setF] = useState({ displayName: '', email: '', password: '', confirm: '' });
  const { submit, error, busy } = useSubmit(async () => {
    if (f.password !== f.confirm) throw new Error('The passwords don’t match');
    const err = validatePassword(f.password);
    if (err) throw new Error(err);
    return backend.setup({ displayName: f.displayName, email: f.email, password: f.password });
  }, onDone);
  return (
    <Frame
      title="First-time setup"
      subtitle="Create the Service Head account. The Service Head then adds the helpdesk executives from the Users page."
    >
      <form onSubmit={submit} className="stack">
        <label className="field">
          Service Head's name
          <input required value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        </label>
        <label className="field">
          Email
          <input type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="field">
          Password <span className="hint">at least 8 characters, letters and numbers</span>
          <input type="password" autoComplete="new-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        <label className="field">
          Confirm password
          <input type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
          Create Service Head account
        </button>
      </form>
    </Frame>
  );
}

export function ChangePasswordForm({
  user,
  onDone,
  submitLabel = 'Change password',
}: {
  user: SessionUser;
  onDone: () => void;
  submitLabel?: string;
}) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const { submit, error, busy } = useSubmit(async () => {
    if (f.next !== f.confirm) throw new Error('The new passwords don’t match');
    await backend.changePassword(user, f.current, f.next);
  }, () => {
    setF({ current: '', next: '', confirm: '' });
    onDone();
  });
  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        Current password
        <input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
      </label>
      <label className="field">
        New password <span className="hint">at least 8 characters, letters and numbers</span>
        <input type="password" autoComplete="new-password" required value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
      </label>
      <label className="field">
        Confirm new password
        <input type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}

export function ForcePasswordChange({ user, onDone, onLogout }: { user: SessionUser; onDone: () => void; onLogout: () => void }) {
  return (
    <Frame title={`Welcome, ${user.displayName}`} subtitle="Please choose your own password before continuing.">
      <ChangePasswordForm user={user} onDone={onDone} submitLabel="Save and continue" />
      <button className="link" style={{ marginTop: 12 }} onClick={onLogout}>
        Sign out
      </button>
    </Frame>
  );
}
