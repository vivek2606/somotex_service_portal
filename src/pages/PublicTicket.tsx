// Pages the customer opens from a WhatsApp or SMS link, without signing in:
// the progress of their complaint, and a short rating after the job.
// They only ever see the ticket behind the secret in their link.

import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../cloud/supabase';

interface PublicTicketInfo {
  company: string;
  ticketNo: string;
  status: string;
  createdAt: string;
  product: string;
  complaintType: string;
  visitDate?: string;
  visitSlot?: string;
  technician?: string;
  resolvedAt?: string;
  closedAt?: string;
  rating?: number;
  ratedByCustomer?: boolean;
}

const STEPS = ['Registered', 'Technician assigned', 'Work in progress', 'Completed'] as const;

function stepOf(t: PublicTicketInfo): number {
  if (t.status === 'Resolved' || t.status === 'Closed') return 3;
  if (t.status === 'In Progress' || t.status === 'Awaiting Parts') return 2;
  if (t.status === 'Assigned' || t.technician) return 1;
  return 0;
}

const fmtDay = (iso?: string) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '';

export default function PublicTicket({ kind, token }: { kind: 'track' | 'feedback'; token: string }) {
  const [info, setInfo] = useState<PublicTicketInfo | null | undefined>(undefined);
  const [error, setError] = useState<string>();

  const load = () => {
    if (!supabase) {
      setError('This link only works when the service portal is online.');
      return;
    }
    supabase.rpc('public_ticket', { p_token: token }).then(({ data, error: e }) => {
      if (e) setError('We couldn’t load your request right now. Please check your internet connection and try again.');
      else setInfo((data as PublicTicketInfo | null) ?? null);
    });
  };
  useEffect(load, [token]);

  const company = info?.company ?? 'Somotex';
  useEffect(() => {
    document.title = `${company} service`;
  }, [company]);

  return (
    <div className="public">
      <div className="brand">
        <img src="./icon.svg" alt="" />
        <div>
          {company}
          <small>Customer service</small>
        </div>
      </div>
      {error ? (
        <div className="card">
          <p>{error}</p>
        </div>
      ) : info === undefined ? (
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      ) : info === null ? (
        <div className="card">
          <p>This link is not valid. Please contact our service desk.</p>
        </div>
      ) : (
        <>
          <Status t={info} />
          {(kind === 'feedback' || info.status === 'Resolved' || info.status === 'Closed') && <Feedback t={info} token={token} onDone={load} />}
        </>
      )}
    </div>
  );
}

function Status({ t }: { t: PublicTicketInfo }) {
  const step = stepOf(t);
  const cancelled = t.status === 'Cancelled';
  return (
    <div className="card">
      <div className="small muted">Service request</div>
      <h1 style={{ marginBottom: 4 }}>{t.ticketNo}</h1>
      <p className="muted" style={{ marginBottom: 0 }}>
        {t.product} · {t.complaintType}
        <br />
        Logged {fmtDay(t.createdAt)}
      </p>
      {cancelled ? (
        <p style={{ marginTop: 12 }}>This request has been cancelled. Please contact us if you still need help.</p>
      ) : (
        <ul className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? (step === 3 ? 'done' : 'current') : ''}>
              {s}
              {i === 1 && t.technician && step >= 1 && <span className="muted"> · {t.technician}</span>}
              {i === 2 && t.status === 'Awaiting Parts' && <span className="muted"> · waiting for parts</span>}
              {i === 3 && step === 3 && <span className="muted"> · {fmtDay(t.resolvedAt ?? t.closedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      {!cancelled && step < 3 && t.visitDate && (
        <p style={{ marginTop: 12 }}>
          Visit booked for <strong>{fmtDay(t.visitDate)}</strong>
          {t.visitSlot && `, ${t.visitSlot.toLowerCase()}`}.
        </p>
      )}
    </div>
  );
}

function Feedback({ t, token, onDone }: { t: PublicTicketInfo; token: string; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const done = t.status === 'Resolved' || t.status === 'Closed';

  if (!done) return null;
  if (t.ratedByCustomer || sent) {
    return (
      <div className="card">
        <h2>Thank you</h2>
        <p style={{ margin: 0 }}>
          Your rating{t.rating ? ` (${'★'.repeat(t.rating)})` : ''} has been recorded. It helps us improve our service.
        </p>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rating || !supabase) return;
    setBusy(true);
    setError(undefined);
    const { error: err } = await supabase.rpc('submit_feedback', { p_token: token, p_rating: rating, p_comment: comment });
    setBusy(false);
    if (err) setError(/already/i.test(err.message) ? 'Your rating has already been recorded. Thank you.' : 'We couldn’t save your rating. Please try again.');
    else {
      setSent(true);
      onDone();
    }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>How did we do?</h2>
      <p className="muted">Please rate the service on your {t.product}.</p>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={n <= rating ? 'on' : ''} aria-label={`${n} star${n > 1 ? 's' : ''}`} aria-checked={n === rating} role="radio" onClick={() => setRating(n)}>
            ★
          </button>
        ))}
      </div>
      <label className="field">
        Anything you’d like to tell us? (optional)
        <textarea value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !rating} style={{ marginTop: 10, width: '100%' }}>
        {busy ? 'Sending…' : 'Send rating'}
      </button>
    </form>
  );
}
