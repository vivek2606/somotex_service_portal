import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider, backend, useAuth, useSyncState } from './auth/AuthContext';
import { ForcePasswordChange, LoginScreen, SetupScreen } from './auth/AuthScreens';
import { SettingsProvider, useSettings } from './components/SettingsContext';
import { fmtDateTime, Icon, Loading, ToastProvider } from './components/ui';
import { ROLE_LABEL, type SessionUser } from './db/auth';
import { db } from './db/db';
import { OPEN_STATUSES } from './db/service';
import { hasReachedLagos } from './db/returns';
import { publicRoute } from './lib/links';
import { EscalationNotifier } from './components/Escalations';

// Each page is its own chunk so the first load stays small.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Complaints = lazy(() => import('./pages/Complaints'));
const NewComplaint = lazy(() => import('./pages/NewComplaint'));
const ComplaintDetail = lazy(() => import('./pages/ComplaintDetail'));
const JobCard = lazy(() => import('./pages/JobCard'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Inventory = lazy(() => import('./pages/Inventory'));
const ItemDetail = lazy(() => import('./pages/ItemDetail'));
const StockImport = lazy(() => import('./pages/StockImport'));
const Reorder = lazy(() => import('./pages/Reorder'));
const Cylinders = lazy(() => import('./pages/Cylinders'));
const Requests = lazy(() => import('./pages/Requests'));
const Schedule = lazy(() => import('./pages/Schedule'));
const GasEfficiency = lazy(() => import('./pages/GasEfficiency'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Reports = lazy(() => import('./pages/Reports'));
const Technicians = lazy(() => import('./pages/Technicians'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const Insights = lazy(() => import('./pages/Insights'));
const Tools = lazy(() => import('./pages/Tools'));
const Returns = lazy(() => import('./pages/Returns'));
const PublicTicket = lazy(() => import('./pages/PublicTicket'));

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function SyncStatus() {
  const s = useSyncState();
  if (!s) return null;
  let cls = 'ok';
  let text = s.lastSyncAt ? `All changes saved · ${fmtDateTime(s.lastSyncAt)}` : 'Connecting…';
  if (s.rejected > 0) {
    cls = 'rejected';
    text = `${s.rejected} change${s.rejected === 1 ? '' : 's'} refused by the server`;
  } else if (s.status === 'syncing' && !s.initialised) {
    cls = 'syncing';
    text = 'Downloading data…';
  } else if (s.status === 'offline') {
    cls = 'offline';
    text = s.pending ? `Offline · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : 'Offline · showing saved data';
  } else if (s.status === 'error') {
    cls = 'error';
    text = `Sync problem: ${s.message ?? 'unknown error'}`;
  } else if (s.pending > 0) {
    cls = 'syncing';
    text = `Saving ${s.pending} change${s.pending === 1 ? '' : 's'}…`;
  }
  return (
    <Link to="/settings?tab=sync" className={`sync ${cls}`} title={s.message}>
      <span className="dot-status" />
      {text}
    </Link>
  );
}

function Shell() {
  const settings = useSettings();
  const { user, logout, can } = useAuth();
  const online = useOnline();
  const openCount = useLiveQuery(() => db.complaints.where('status').anyOf(OPEN_STATUSES).count(), []);
  // Requests someone at Lagos needs to act on: approve or dispatch.
  const requestCount = useLiveQuery(() => db.requests.where('status').anyOf('Requested', 'Approved').count(), []);
  const returnCount = useLiveQuery(() => db.partReturns.filter((r) => !hasReachedLagos(r)).count(), []);
  const alertCount = useLiveQuery(
    () => db.alerts.filter((a) => !a.acknowledged && !a.cleared && a.severity !== 'info').count(),
    [],
  );

  const nav = [
    { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
    { to: '/complaints', label: 'Complaints', icon: 'complaints', count: openCount },
    { to: '/schedule', label: 'Schedule', icon: 'dashboard' },
    { to: '/customers', label: 'Customers', icon: 'customers' },
    { to: '/inventory', label: 'Inventory', icon: 'inventory' },
    { to: '/requests', label: 'Branch requests', icon: 'complaints', count: requestCount },
    { to: '/returns', label: 'Part returns', icon: 'inventory', count: returnCount },
    { to: '/cylinders', label: 'Cylinders', icon: 'inventory' },
    { to: '/tools', label: 'Tools', icon: 'technicians' },
    { to: '/gas', label: 'Gas efficiency', icon: 'reports' },
    { to: '/alerts', label: 'Alerts', icon: 'alerts', count: alertCount, bad: true },
    { to: '/insights', label: 'Insights', icon: 'reports' },
    { to: '/reports', label: 'Reports', icon: 'reports' },
    { to: '/technicians', label: 'Technicians', icon: 'technicians' },
    ...(can('manageUsers') ? [{ to: '/users', label: 'Users', icon: 'customers' }] : []),
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  const byPath = (p: string) => nav.find((n) => n.to === p)!;
  const mobile = [byPath('/'), byPath('/complaints'), { to: '/complaints/new', label: 'New', icon: 'plus' }, byPath('/inventory'), byPath('/alerts'), byPath('/settings')];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <div>
            {settings.companyName}
            <small>Service Portal</small>
          </div>
        </div>
        <NavLink to="/complaints/new" className="btn primary" style={{ width: '100%', marginBottom: 12 }}>
          <Icon name="plus" /> New complaint
        </NavLink>
        <nav className="nav">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : undefined}>
              <Icon name={n.icon} />
              {n.label}
              {'count' in n && !!n.count && <span className={`badge count ${'bad' in n ? 'bad' : 'primary'}`}>{n.count}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="userbox">
          <div className="who">{user?.displayName}</div>
          <div className="small muted">{user?.email}</div>
          <div className="small muted">{user && ROLE_LABEL[user.role]}</div>
          <button className="sm" style={{ marginTop: 8 }} onClick={() => void logout()}>
            Sign out
          </button>
        </div>
        <SyncStatus />
        <div className="small muted" style={{ padding: '4px 10px' }} title="App version">
          v {__APP_VERSION__}
        </div>
      </aside>
      <main className="main">
        {!online && <div className="offline">You're offline. Changes are saved on this device and sent when the connection returns.</div>}
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/complaints" element={<Complaints />} />
            <Route path="/complaints/new" element={<NewComplaint />} />
            <Route path="/complaints/:id" element={<ComplaintDetail />} />
            <Route path="/complaints/:id/job-card" element={<JobCard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/inventory/import" element={<StockImport />} />
            <Route path="/inventory/reorder" element={<Reorder />} />
            <Route path="/inventory/:id" element={<ItemDetail />} />
            <Route path="/cylinders" element={<Cylinders />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/gas" element={<GasEfficiency />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/technicians" element={<Technicians />} />
            {can('manageUsers') && <Route path="/users" element={<Users />} />}
            <Route path="/returns" element={<Returns />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </Suspense>
      </main>
      <EscalationNotifier />
      <nav className="bottomnav">
        {mobile.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/complaints/new'}>
            <Icon name={n.icon} />
            {n.label}
            {'count' in n && !!n.count && <span className="dot">{n.count}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

type Gate = { phase: 'loading' } | { phase: 'setup' } | { phase: 'login' } | { phase: 'in'; user: SessionUser };

export function App() {
  // Customers open their status and feedback links without signing in.
  const pub = publicRoute();
  if (pub) {
    return (
      <Suspense fallback={<Loading />}>
        <PublicTicket kind={pub.kind} token={pub.token} />
      </Suspense>
    );
  }
  return <StaffApp />;
}

function StaffApp() {
  const [gate, setGate] = useState<Gate>({ phase: 'loading' });

  useEffect(() => {
    void (async () => {
      // Offline, assume setup is done and fall back to the saved session.
      const needsSetup = await backend.needsSetup().catch(() => false);
      if (needsSetup) return setGate({ phase: 'setup' });
      const user = await backend.restore().catch(() => undefined);
      setGate(user ? { phase: 'in', user } : { phase: 'login' });
    })();
  }, []);

  const setUser = (u?: SessionUser) => setGate(u ? { phase: 'in', user: u } : { phase: 'login' });
  const user = gate.phase === 'in' ? gate.user : undefined;

  let content;
  if (gate.phase === 'loading') content = <Loading />;
  else if (gate.phase === 'setup') content = <SetupScreen onDone={setUser} />;
  else if (gate.phase === 'login') content = <LoginScreen onLogin={setUser} />;
  else if (gate.user.mustChangePassword)
    content = (
      <ForcePasswordChange
        user={gate.user}
        onDone={() => setUser({ ...gate.user, mustChangePassword: false })}
        onLogout={() =>
          void backend.logout().then(() => {
            window.location.hash = '#/';
            setUser(undefined);
          })
        }
      />
    );
  else
    content = (
      <SettingsProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </SettingsProvider>
    );

  return (
    <HashRouter>
      <AuthProvider user={user} setUser={setUser}>
        {content}
      </AuthProvider>
    </HashRouter>
  );
}
