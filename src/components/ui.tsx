import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AlertSeverity, ComplaintStatus, Priority } from '../db/types';

// ------------------------------------------------------------- formatting

export const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

export const fmtNum = (n: number, digits = 2) =>
  n.toLocaleString(undefined, { maximumFractionDigits: digits });

export const fmtMoney = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function fmtDuration(ms: number) {
  const h = Math.abs(ms) / 3600000;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

// ------------------------------------------------------------------ badges

const STATUS_TONE: Record<ComplaintStatus, string> = {
  Registered: 'info',
  Assigned: 'primary',
  'In Progress': 'primary',
  'Awaiting Parts': 'warn',
  Resolved: 'ok',
  Closed: 'ok',
  Cancelled: '',
};

export const StatusBadge = ({ status }: { status: ComplaintStatus }) => (
  <span className={`badge ${STATUS_TONE[status]}`}>{status}</span>
);

const PRIORITY_TONE: Record<Priority, string> = { Low: '', Normal: 'info', High: 'warn', Critical: 'bad' };

export const PriorityBadge = ({ priority }: { priority: Priority }) => (
  <span className={`badge ${PRIORITY_TONE[priority]}`}>{priority}</span>
);

export const SeverityBadge = ({ severity }: { severity: AlertSeverity }) => (
  <span className={`badge ${severity}`}>{severity}</span>
);

// ------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  complaints: 'M4 4h16v12H5.2L4 17.2zm4 5h8M8 12h5',
  customers: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
  inventory: 'M3 7l9-4 9 4v10l-9 4-9-4zm0 0l9 4 9-4M12 11v10',
  alerts: 'M12 3l10 18H2zm0 6v5m0 3v.5',
  reports: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  technicians: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4L15 12l-3-3z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ------------------------------------------------------------------- toast

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Runs an async action, showing its error (if any) as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        await fn();
        if (success) toast(success);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}
