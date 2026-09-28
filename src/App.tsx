import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { SettingsProvider, useSettings } from './components/SettingsContext';
import { Icon, Loading, ToastProvider } from './components/ui';
import { db } from './db/db';
import { OPEN_STATUSES } from './db/service';

// Each page is its own chunk so the first load stays small.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Complaints = lazy(() => import('./pages/Complaints'));
const NewComplaint = lazy(() => import('./pages/NewComplaint'));
const ComplaintDetail = lazy(() => import('./pages/ComplaintDetail'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Inventory = lazy(() => import('./pages/Inventory'));
const ItemDetail = lazy(() => import('./pages/ItemDetail'));
const StockImport = lazy(() => import('./pages/StockImport'));
const GasEfficiency = lazy(() => import('./pages/GasEfficiency'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Reports = lazy(() => import('./pages/Reports'));
const Technicians = lazy(() => import('./pages/Technicians'));
const Settings = lazy(() => import('./pages/Settings'));

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

function Shell() {
  const settings = useSettings();
  const online = useOnline();
  const openCount = useLiveQuery(() => db.complaints.where('status').anyOf(OPEN_STATUSES).count(), []);
  const alertCount = useLiveQuery(
    () => db.alerts.filter((a) => !a.acknowledged && a.severity !== 'info').count(),
    [],
  );

  const nav = [
    { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
    { to: '/complaints', label: 'Complaints', icon: 'complaints', count: openCount },
    { to: '/customers', label: 'Customers', icon: 'customers' },
    { to: '/inventory', label: 'Inventory', icon: 'inventory' },
    { to: '/gas', label: 'Gas efficiency', icon: 'reports' },
    { to: '/alerts', label: 'Alerts', icon: 'alerts', count: alertCount, bad: true },
    { to: '/reports', label: 'Reports', icon: 'reports' },
    { to: '/technicians', label: 'Technicians', icon: 'technicians' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  const mobile = [nav[0], nav[1], { to: '/complaints/new', label: 'New', icon: 'plus' }, nav[3], nav[5], nav[8]];

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
            <NavLink key={n.to} to={n.to} end={n.end}>
              <Icon name={n.icon} />
              {n.label}
              {!!n.count && <span className={`badge count ${n.bad ? 'bad' : 'primary'}`}>{n.count}</span>}
            </NavLink>
          ))}
        </nav>
        <p className="small muted" style={{ padding: '16px 10px 0' }}>
          Signed in as <strong>{settings.currentUser}</strong>
        </p>
      </aside>
      <main className="main">
        {!online && <div className="offline">You're offline. Changes are saved on this device.</div>}
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/complaints" element={<Complaints />} />
            <Route path="/complaints/new" element={<NewComplaint />} />
            <Route path="/complaints/:id" element={<ComplaintDetail />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/inventory/import" element={<StockImport />} />
            <Route path="/inventory/:id" element={<ItemDetail />} />
            <Route path="/gas" element={<GasEfficiency />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/technicians" element={<Technicians />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </Suspense>
      </main>
      <nav className="bottomnav">
        {mobile.map((n) => (
          <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : n.to === '/complaints/new'}>
            <Icon name={n.icon} />
            {n.label}
            {'count' in n && !!n.count && <span className="dot">{n.count}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <SettingsProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </SettingsProvider>
    </HashRouter>
  );
}
