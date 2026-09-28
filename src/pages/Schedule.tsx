import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { Empty, Loading, PriorityBadge, StatusBadge, useAction } from '../components/ui';
import { db } from '../db/db';
import { OPEN_STATUSES } from '../db/service';
import { VISIT_SLOTS, type Complaint, type Customer, type Technician, type VisitSlot } from '../db/types';
import { isMissedVisit, localDay, markReminded, reminderText, scheduleVisit, slotOrder } from '../db/visits';
import { whatsappLink } from '../lib/phone';

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};

export default function Schedule() {
  const settings = useSettings();
  const [day, setDay] = useState(localDay(new Date()));
  const [branch, setBranch] = useState(() => {
    try {
      return localStorage.getItem('somotex.branch') ?? '';
    } catch {
      return '';
    }
  });

  const data = useLiveQuery(async () => {
    const [open, technicians] = await Promise.all([
      db.complaints.where('status').anyOf(OPEN_STATUSES).toArray(),
      db.technicians.filter((t) => t.active).sortBy('name'),
    ]);
    const customers = new Map(
      (await db.customers.bulkGet([...new Set(open.map((c) => c.customerId))])).filter(Boolean).map((c) => [c!.id, c!]),
    );
    return { open, technicians, customers };
  }, []);

  const view = useMemo(() => {
    if (!data) return undefined;
    const inBranch = (c: Complaint) => !branch || c.branch === branch;
    const today = data.open.filter((c) => c.visitDate === day && inBranch(c)).sort((a, b) => slotOrder(a.visitSlot) - slotOrder(b.visitSlot));
    const missed = data.open.filter((c) => inBranch(c) && isMissedVisit(c));
    const unscheduled = data.open
      .filter((c) => inBranch(c) && !c.visitDate)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const techs = data.technicians.filter((t) => !branch || !t.branch || t.branch === branch);
    const byTech = techs.map((t) => ({ tech: t, visits: today.filter((c) => c.technicianId === t.id) }));
    const noTech = today.filter((c) => !c.technicianId || !techs.some((t) => t.id === c.technicianId));
    return { today, missed, unscheduled, byTech, noTech, techs };
  }, [data, day, branch]);

  if (!data || !view) return <Loading />;
  const label = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Visit schedule</h1>
          <div className="small muted">{label}</div>
        </div>
        <span className="spacer" />
        <div className="row no-print">
          <button className="sm" onClick={() => setDay(addDays(day, -1))}>
            ← Prev
          </button>
          <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 'auto' }} />
          <button className="sm" onClick={() => setDay(addDays(day, 1))}>
            Next →
          </button>
          <button className="sm" onClick={() => setDay(localDay(new Date()))}>
            Today
          </button>
          <select value={branch} onChange={(e) => setBranch(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All branches</option>
            {settings.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <button className="sm" onClick={() => window.print()}>
            Print day plan
          </button>
        </div>
      </div>

      {view.missed.length > 0 && (
        <div className="card no-print" style={{ borderColor: 'var(--bad)' }}>
          <h2>Missed visits ({view.missed.length})</h2>
          <p className="small muted">The booked time has passed and the job hasn't been started. Call the customer and rebook.</p>
          {view.missed.map((c) => (
            <VisitRow key={c.id} c={c} customer={data.customers.get(c.customerId)} techs={data.technicians} missed />
          ))}
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {view.byTech.map(({ tech, visits }) => (
          <div key={tech.id} className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>{tech.name}</h2>
              <span className="small muted">
                {tech.branch ?? 'Any branch'} · {visits.length} visit{visits.length === 1 ? '' : 's'}
              </span>
            </div>
            {visits.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                Free all day.
              </p>
            ) : (
              visits.map((c) => <VisitRow key={c.id} c={c} customer={data.customers.get(c.customerId)} techs={data.technicians} />)
            )}
          </div>
        ))}
        {view.noTech.length > 0 && (
          <div className="card">
            <h2>No technician yet</h2>
            {view.noTech.map((c) => (
              <VisitRow key={c.id} c={c} customer={data.customers.get(c.customerId)} techs={data.technicians} />
            ))}
          </div>
        )}
      </div>

      <div className="card no-print" style={{ marginTop: 14 }}>
        <h2>Open jobs without a visit ({view.unscheduled.length})</h2>
        {view.unscheduled.length === 0 ? (
          <Empty>Every open job has a visit booked.</Empty>
        ) : (
          view.unscheduled.map((c) => <BookRow key={c.id} c={c} customer={data.customers.get(c.customerId)} techs={view.techs} day={day} />)
        )}
      </div>
    </div>
  );
}

function VisitRow({ c, customer, techs, missed }: { c: Complaint; customer?: Customer; techs: Technician[]; missed?: boolean }) {
  const settings = useSettings();
  const tech = techs.find((t) => t.id === c.technicianId);
  const text = customer ? reminderText(c, customer.name, tech?.name, settings.companyName) : '';
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
      <div className="row between">
        <div>
          <strong>{c.visitSlot ?? 'Any time'}</strong> · <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link> <PriorityBadge priority={c.priority} />{' '}
          <StatusBadge status={c.status} />
          {missed && <span className="badge bad" style={{ marginLeft: 4 }}>Missed {c.visitDate}</span>}
        </div>
        {missed && tech && <span className="small">{tech.name}</span>}
      </div>
      <div>
        {customer?.name} · <a href={`tel:${customer?.phone}`}>{customer?.phone}</a>
      </div>
      <div className="small muted">
        {[customer?.address, customer?.city].filter(Boolean).join(', ')} · {c.equipment.brand} {c.equipment.category} · {c.complaintType}
      </div>
      {customer && (
        <div className="row no-print" style={{ marginTop: 4 }}>
          <a
            className="btn sm"
            href={whatsappLink(customer.phone, settings.countryCode, text)}
            target="_blank"
            rel="noreferrer"
            onClick={() => void markReminded(db, settings, c.id, 'WhatsApp')}
          >
            {c.visitRemindedAt ? 'Remind again' : 'WhatsApp reminder'}
          </a>
          {c.visitRemindedAt && <span className="small muted">reminded</span>}
        </div>
      )}
    </div>
  );
}

function BookRow({ c, customer, techs, day }: { c: Complaint; customer?: Customer; techs: Technician[]; day: string }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [date, setDate] = useState(day);
  const [slot, setSlot] = useState<VisitSlot>(VISIT_SLOTS[0]);
  const [tech, setTech] = useState(c.technicianId ?? '');
  const sorted = [...techs].sort((a, b) => Number(b.branch === c.branch) - Number(a.branch === c.branch) || a.name.localeCompare(b.name));
  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
      <div style={{ flex: '2 1 260px' }}>
        <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link> <PriorityBadge priority={c.priority} /> · {customer?.name}
        <div className="small muted">
          {c.branch ?? '—'} · {c.equipment.brand} {c.equipment.category} · {c.preferredVisit ? `prefers ${c.preferredVisit}` : 'no preference given'}
        </div>
      </div>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ flex: '1 1 140px' }} />
      <select value={slot} onChange={(e) => setSlot(e.target.value as VisitSlot)} style={{ flex: '1 1 150px' }}>
        {VISIT_SLOTS.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <select value={tech} onChange={(e) => setTech(e.target.value)} style={{ flex: '1 1 150px' }}>
        <option value="">Technician…</option>
        {sorted.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.branch && t.branch !== c.branch ? ` (${t.branch})` : ''}
          </option>
        ))}
      </select>
      <button
        className="sm primary"
        disabled={busy || !date}
        onClick={() => run(() => scheduleVisit(db, settings, c.id, { date, slot, technicianId: tech || undefined }), 'Visit booked')}
      >
        Book
      </button>
    </div>
  );
}
