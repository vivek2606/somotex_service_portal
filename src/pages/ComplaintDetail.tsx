import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SuggestionPanel } from '../components/Diagnosis';
import { useSettings } from '../components/SettingsContext';
import {
  Empty,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  Loading,
  PriorityBadge,
  SeverityBadge,
  StatusBadge,
  useAction,
  useToast,
} from '../components/ui';
import { db, runtime } from '../db/db';
import {
  acknowledgeAlert,
  assignTechnician,
  confirmedCauseCounts,
  ensurePublicToken,
  isOpen,
  isTempTicket,
  issueToComplaint,
  logCustomerContact,
  addLog,
  materialUsage,
  returnFromComplaint,
  setStatus,
  updateJobDetails,
} from '../db/service';
import { LEAK_POINTS, POWER_SOURCES, type LeakPoint, type PowerSource } from '../db/types';
import { ComplaintReturnsCard } from '../components/PartReturns';
import { feedbackLink, trackLink } from '../lib/links';
import { badVoltage, VOLTAGE_BAND } from '../lib/insights';
import { BRAZING_METHODS, CALL_OUTCOMES, GAS_TYPES, VISIT_SLOTS, type VisitSlot, type BrazingMethod, type CallOutcome, type Complaint, type ComplaintStatus, type JobType } from '../db/types';
import { expectedRefrigerant, issuePlan, JOB_TYPES, usesRefrigerant } from '../lib/consumption';
import { causesFor, diagnose, questionnaire } from '../lib/diagnosis';
import { applyWarranty, warrantyFor } from '../lib/warranty';
import { WarrantyNote } from '../components/Warranty';
import { CylinderPanel } from '../components/CylinderPanel';
import { toInternational } from '../lib/phone';
import { isMissedVisit, scheduleVisit } from '../db/visits';

const NEXT: Record<ComplaintStatus, ComplaintStatus[]> = {
  Registered: ['Assigned', 'In Progress', 'Cancelled'],
  Assigned: ['In Progress', 'Awaiting Parts', 'Resolved', 'Cancelled'],
  'In Progress': ['Awaiting Parts', 'Resolved', 'Closed'],
  'Awaiting Parts': ['In Progress', 'Resolved'],
  Resolved: ['Closed', 'In Progress'],
  Closed: ['In Progress'],
  Cancelled: ['Registered'],
};

export default function ComplaintDetail() {
  const id = useParams().id ?? '';
  const c = useLiveQuery(() => db.complaints.get(id), [id]);
  if (c === undefined) return <Loading />;
  return <Detail c={c} />;
}

function Detail({ c }: { c: Complaint }) {
  const settings = useSettings();
  const { can: canDo } = useAuth();
  const { run, busy } = useAction();
  const id = c.id;
  const customer = useLiveQuery(() => db.customers.get(c.customerId), [c.customerId]);
  const technicians = useLiveQuery(() => db.technicians.toArray(), []);
  const logs = useLiveQuery(() => db.logs.where('complaintId').equals(id).reverse().sortBy('at'), [id]);
  const alerts = useLiveQuery(() => db.alerts.where('complaintId').equals(id).filter((a) => !a.cleared).toArray(), [id]);
  const usage = useLiveQuery(() => materialUsage(db, id), [id, c.updatedAt, logs?.length]);
  const items = useLiveQuery(() => db.items.filter((i) => i.active).sortBy('name'), []);
  const confirmed = useLiveQuery(() => confirmedCauseCounts(db), []);
  const tech = technicians?.find((t) => t.id === c.technicianId);

  const overdue = isOpen(c) && new Date(c.dueAt).getTime() < Date.now();
  const tat = c.resolvedAt ? new Date(c.resolvedAt).getTime() - new Date(c.createdAt).getTime() : undefined;

  const diagnosis = useMemo(
    () =>
      diagnose(
        c.equipment.category,
        c.diagnosis?.answers ?? {},
        `${c.complaintType} ${c.customerStatement ?? ''} ${c.description}`,
        confirmed ?? {},
        5,
      ),
    [c, confirmed],
  );

  const changeStatus = (s: ComplaintStatus) => {
    const note = s === 'Cancelled' || (s === 'In Progress' && !isOpen(c)) ? prompt(`Reason for “${s}”?`) ?? undefined : undefined;
    run(() => setStatus(db, settings, id, s, note), `Status changed to ${s}`);
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>
            {c.ticketNo} <StatusBadge status={c.status} /> <PriorityBadge priority={c.priority} />
            {c.branch && <span className="badge" style={{ marginLeft: 6 }}>{c.branch}</span>}
          </h1>
          <div className="small muted">
            Logged {fmtDateTime(c.createdAt)} by {c.loggedBy}
            {c.loggedByEmail && ` (${c.loggedByEmail})`} via {c.source}
            {c.status === 'Closed' && c.closedBy && (
              <>
                {' '}
                · Closed {fmtDateTime(c.closedAt)} by {c.closedBy}
                {c.closedByEmail && ` (${c.closedByEmail})`}
              </>
            )}{' '}
            ·{' '}
            {isOpen(c) ? (
              <span style={{ color: overdue ? 'var(--bad)' : undefined }}>
                {overdue ? 'Overdue by ' : 'Due in '}
                {fmtDuration(new Date(c.dueAt).getTime() - Date.now())}
              </span>
            ) : (
              tat !== undefined && <>Resolved in {fmtDuration(tat)}</>
            )}
          </div>
        </div>
        <span className="spacer" />
        <div className="row">
          <Link to={`/complaints/${id}/job-card`} className="btn">
            Job card
          </Link>
          {isOpen(c) && (
            <Link to={`/requests?complaint=${id}`} className="btn">
              Request from Lagos
            </Link>
          )}
          {NEXT[c.status]
            // Executives move open jobs forward; re-opening and cancelling are for the Service Head.
            .filter((s) => canDo('reopenOrCancel') || (isOpen(c) && s !== 'Cancelled') || (c.status === 'Resolved' && s === 'Closed'))
            .map((s) => (
            <button key={s} className={s === 'Closed' || s === 'Resolved' ? 'primary' : ''} disabled={busy} onClick={() => changeStatus(s)}>
              {s === 'In Progress' && !isOpen(c) ? 'Re-open' : s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <div className="card">
            <div className="grid cols-2">
              <div>
                <h3>Customer</h3>
                {customer && (
                  <dl className="kv">
                    <dt>Name</dt>
                    <dd>
                      <Link to={`/customers/${customer.id}`}>{customer.name}</Link>
                    </dd>
                    <dt>Phone</dt>
                    <dd>
                      <a href={`tel:${customer.phone}`}>{customer.phone}</a>
                      {customer.altPhone && <> · {customer.altPhone}</>}
                    </dd>
                    <dt>Address</dt>
                    <dd>{[customer.address, customer.city].filter(Boolean).join(', ')}</dd>
                    {c.callerName && (
                      <>
                        <dt>Caller</dt>
                        <dd>
                          {c.callerName} {c.callerPhone}
                        </dd>
                      </>
                    )}
                    {c.preferredVisit && (
                      <>
                        <dt>Visit</dt>
                        <dd>{c.preferredVisit}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
              <div>
                <h3>Product</h3>
                <dl className="kv">
                  <dt>Unit</dt>
                  <dd>
                    {c.equipment.brand} {c.equipment.category}
                  </dd>
                  <dt>Model</dt>
                  <dd>{c.equipment.model || '—'}</dd>
                  <dt>Serial</dt>
                  <dd>{c.equipment.serialNo || '—'}</dd>
                  {c.equipment.capacity && (
                    <>
                      <dt>Capacity</dt>
                      <dd>
                        {fmtNum(c.equipment.capacity)} {c.equipment.capacityUnit}
                        {c.equipment.refrigerant && c.equipment.refrigerant !== 'None' && <> · {c.equipment.refrigerant}</>}
                      </dd>
                    </>
                  )}
                  <dt>Warranty</dt>
                  <dd>
                    <InvoiceWarranty c={c} />
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>{c.complaintType}</h2>
            {c.customerStatement && (
              <blockquote style={{ marginBottom: 10 }}>
                “{c.customerStatement}”
                <div className="small muted">Customer, at logging</div>
              </blockquote>
            )}
            {c.description && <p>{c.description}</p>}
            {c.diagnosis && Object.keys(c.diagnosis.answers).length > 0 && (
              <details>
                <summary className="small" style={{ cursor: 'pointer' }}>
                  Helpdesk questionnaire ({Object.keys(c.diagnosis.answers).length} answers)
                </summary>
                <dl className="kv small" style={{ marginTop: 8 }}>
                  {questionnaire(c.equipment.category)
                    .filter((q) => c.diagnosis!.answers[q.id])
                    .map((q) => (
                      <FragmentKV key={q.id} k={q.text} v={c.diagnosis!.answers[q.id]} />
                    ))}
                </dl>
              </details>
            )}
            <h3 style={{ marginTop: 14 }}>Likely causes</h3>
            <SuggestionPanel diagnosis={{ ...diagnosis, advice: [] }} />
          </div>

          <JobCard c={c} />
          <MaterialsCard c={c} usage={usage} items={items} />
          <ComplaintReturnsCard c={c} usage={usage} />

          {!!alerts?.length && (
            <div className="card">
              <h2>Consumption alerts</h2>
              {alerts.map((a) => (
                <div key={a.id} className={`alert-box ${a.severity}`}>
                  <div className="row between">
                    <SeverityBadge severity={a.severity} />
                    {a.acknowledged ? (
                      <span className="small muted">Reviewed: {a.ackNote}</span>
                    ) : !canDo('reviewAlerts') ? (
                      <span className="small muted">Awaiting Service Head review</span>
                    ) : (
                      <button
                        className="sm"
                        onClick={() => {
                          const note = prompt('Review note (why was this acceptable, or what action was taken?)');
                          if (note !== null) run(() => acknowledgeAlert(db, settings, a.id, note), 'Alert reviewed');
                        }}
                      >
                        Mark reviewed
                      </button>
                    )}
                  </div>
                  <p style={{ margin: '6px 0 0' }}>{a.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <h2>Technician &amp; branch</h2>
            <label className="field" style={{ marginBottom: 8 }}>
              Branch
              <select
                value={c.branch ?? ''}
                disabled={busy}
                onChange={(e) => run(() => updateJobDetails(db, settings, id, { branch: e.target.value || undefined }), 'Branch updated')}
              >
                <option value="">Not set</option>
                {settings.branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <select
                value={c.technicianId ?? ''}
                disabled={busy}
                onChange={(e) => e.target.value && run(() => assignTechnician(db, settings, id, e.target.value), 'Technician assigned')}
                style={{ flex: 1 }}
              >
                <option value="">Unassigned</option>
                {technicians
                  ?.filter((t) => t.active || t.id === c.technicianId)
                  .sort((x, y) => Number(y.branch === c.branch) - Number(x.branch === c.branch) || x.name.localeCompare(y.name))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.branch && t.branch !== c.branch ? ` (${t.branch})` : ''}
                    </option>
                  ))}
              </select>
              {tech && (
                <a className="btn" href={`tel:${tech.phone}`}>
                  Call
                </a>
              )}
            </div>
          </div>

          {customer && <CustomerUpdateCard c={c} customerName={customer.name} phone={customer.phone} techName={tech?.name} />}
          {isOpen(c) && <VisitCard c={c} />}
          <CustomerContactCard complaintId={id} />
          <NoteCard complaintId={id} />

          <div className="card">
            <h2>Timeline</h2>
            {!logs?.length ? (
              <Empty>No activity yet.</Empty>
            ) : (
              <ul className="timeline">
                {logs.map((l) => (
                  <li key={l.id} className={l.kind}>
                    <div>
                      {l.outcome && <span className="badge ok" style={{ marginRight: 6 }}>{l.outcome}</span>}
                      {l.text}
                    </div>
                    <div className="meta">
                      {fmtDateTime(l.at)} · {l.by}
                      {l.byEmail && ` (${l.byEmail})`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ whiteSpace: 'normal' }}>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function JobCard({ c }: { c: Complaint }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [f, setF] = useState(() => pickJob(c));
  useEffect(() => setF(pickJob(c)), [c]);
  const causes = causesFor(c.equipment.category);
  const hasGas = usesRefrigerant(c.equipment.category);
  // Warranty on the day the complaint was logged decides who pays.
  const w = warrantyFor(c.equipment, settings.warrantyRules, new Date(c.createdAt));
  const chargeHint =
    c.equipment.warranty === 'AMC'
      ? 'AMC contract: charge as per the contract.'
      : f.jobType === 'Compressor Replacement' && w.compressorCovered
        ? 'Compressor is under its extended warranty.'
        : c.equipment.warranty === 'In Warranty'
          ? 'In warranty: normally no charge for parts and labour.'
          : undefined;
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const exp = hasGas ? expectedRefrigerant(c.equipment, f.jobType, f.pipeLengthM, settings.norms) : undefined;
  // Everything electrical except gas cookers can be damaged by bad power.
  const hasPower = c.equipment.category !== 'Gas Cooker';
  const needsLeakPoint = (f.jobType === 'Leak Repair + Full Recharge' || f.jobType === 'Gas Top-up') && !f.leakPoints?.length;
  const customerRated = c.feedbackVia === 'customer';

  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() => updateJobDetails(db, settings, c.id, f), 'Job details saved');
  };

  return (
    <form className="card" onSubmit={save}>
      <h2>Job &amp; closure</h2>
      <div className="form-grid">
        <label className="field">
          Job type
          <select value={f.jobType ?? ''} onChange={(e) => setF({ ...f, jobType: (e.target.value || undefined) as JobType })}>
            <option value="">Select…</option>
            {JOB_TYPES.map((j) => (
              <option key={j}>{j}</option>
            ))}
          </select>
        </label>
        {hasGas && (
          <>
            <label className="field">
              Total pipe length (m)
              <input type="number" inputMode="decimal" min="0" step="any" value={f.pipeLengthM ?? ''} onChange={(e) => setF({ ...f, pipeLengthM: num(e.target.value) })} />
            </label>
            <label className="field">
              Brazed joints
              <input type="number" inputMode="numeric" min="0" value={f.brazedJoints ?? ''} onChange={(e) => setF({ ...f, brazedJoints: num(e.target.value) })} />
            </label>
            <label className="field">
              Brazing method
              <select value={f.brazingMethod ?? ''} onChange={(e) => setF({ ...f, brazingMethod: (e.target.value || undefined) as BrazingMethod })}>
                <option value="">—</option>
                {BRAZING_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="field inline" style={{ alignSelf: 'end', minHeight: 38 }}>
              <input type="checkbox" checked={!!f.nitrogenPurged} onChange={(e) => setF({ ...f, nitrogenPurged: e.target.checked })} />
              Nitrogen purge while brazing
            </label>
            <label className="field">
              Circuit flushed (m)
              <input type="number" inputMode="decimal" min="0" step="any" value={f.flushedPipeM ?? ''} onChange={(e) => setF({ ...f, flushedPipeM: num(e.target.value) })} />
            </label>
            <label className="field">
              Refrigerant recovered (g)
              <input type="number" inputMode="numeric" min="0" value={f.recoveredG ?? ''} onChange={(e) => setF({ ...f, recoveredG: num(e.target.value) })} />
            </label>
            <label className="field inline" style={{ alignSelf: 'end', minHeight: 38 }}>
              <input type="checkbox" checked={!!f.pressureTested} onChange={(e) => setF({ ...f, pressureTested: e.target.checked })} />
              Nitrogen pressure test done
            </label>
          </>
        )}
        {hasGas && (
          <div className="field span-all">
            Leak found at
            <div className="row">
              {LEAK_POINTS.map((p) => (
                <label key={p} className="field inline small">
                  <input
                    type="checkbox"
                    checked={f.leakPoints?.includes(p) ?? false}
                    onChange={(e) => {
                      const next = e.target.checked ? [...(f.leakPoints ?? []), p] : (f.leakPoints ?? []).filter((x) => x !== p);
                      setF({ ...f, leakPoints: next.length ? (next as LeakPoint[]) : undefined });
                    }}
                  />
                  {p}
                </label>
              ))}
            </div>
            {needsLeakPoint && <span className="hint" style={{ color: 'var(--warn)' }}>Record where the leak was, so repeat leak points show up in Insights.</span>}
          </div>
        )}
        {hasPower && (
          <>
            <label className="field">
              Supply voltage at the unit (V)
              <input type="number" inputMode="numeric" min="0" max="500" value={f.supplyVoltage ?? ''} onChange={(e) => setF({ ...f, supplyVoltage: num(e.target.value) })} />
              {badVoltage(f.supplyVoltage) && (
                <span className="hint" style={{ color: 'var(--bad)' }}>
                  Outside {VOLTAGE_BAND.low}–{VOLTAGE_BAND.high} V: advise a stabiliser.
                </span>
              )}
            </label>
            <label className="field">
              Stabiliser / AVS fitted
              <select value={f.stabiliser ?? ''} onChange={(e) => setF({ ...f, stabiliser: (e.target.value || undefined) as 'Yes' | 'No' | undefined })}>
                <option value="">Not checked</option>
                <option>Yes</option>
                <option>No</option>
              </select>
            </label>
            <label className="field">
              Power source
              <select value={f.powerSource ?? ''} onChange={(e) => setF({ ...f, powerSource: (e.target.value || undefined) as PowerSource | undefined })}>
                <option value="">Not checked</option>
                {POWER_SOURCES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field span-all">
          Confirmed cause
          <select value={f.confirmedCauseId ?? ''} onChange={(e) => setF({ ...f, confirmedCauseId: e.target.value || undefined })}>
            <option value="">Select the actual cause…</option>
            {causes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="other">Other (describe below)</option>
          </select>
          <span className="hint">This improves future suggestions for this product type.</span>
        </label>
        <label className="field span-all">
          Root cause / findings
          <textarea value={f.rootCause ?? ''} onChange={(e) => setF({ ...f, rootCause: e.target.value })} />
        </label>
        <label className="field span-all">
          Resolution / work done *
          <textarea value={f.resolution ?? ''} onChange={(e) => setF({ ...f, resolution: e.target.value })} />
        </label>
        <label className="field">
          Service charge ({settings.currency})
          <input type="number" inputMode="numeric" min="0" value={f.serviceCharge ?? ''} onChange={(e) => setF({ ...f, serviceCharge: num(e.target.value) })} />
          {chargeHint && <span className="hint">{chargeHint}</span>}
        </label>
        {customerRated ? (
          <div className="field">
            Customer feedback
            <div>
              {'★'.repeat(c.customerFeedback ?? 0)} ({c.customerFeedback}) <span className="badge ok">from the customer</span>
            </div>
            {c.feedbackComment && <span className="hint">“{c.feedbackComment}”</span>}
          </div>
        ) : (
        <label className="field">
          Customer feedback
          <select
            value={f.customerFeedback ?? ''}
            onChange={(e) => setF({ ...f, customerFeedback: (num(e.target.value) as Complaint['customerFeedback']) ?? undefined })}
          >
            <option value="">—</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {'★'.repeat(n)} ({n})
              </option>
            ))}
          </select>
          <span className="hint">Or send the customer the rating link from “Send customer update”.</span>
        </label>
        )}
      </div>
      {hasGas && (f.brazedJoints ?? 0) > 0 && !f.nitrogenPurged && (
        <p className="small" style={{ marginTop: 10, color: 'var(--warn)' }}>
          Brazing without a nitrogen purge leaves oxide scale that can block the capillary or expansion valve and bring the unit back.
        </p>
      )}
      {exp && exp.expectedG > 0 && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Refrigerant budget for this job: <strong>{exp.expectedG} g</strong> ({exp.breakdown.join('; ')})
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" className="primary" disabled={busy}>
          Save job details
        </button>
      </div>
    </form>
  );
}

function pickJob(c: Complaint) {
  return {
    jobType: c.jobType,
    pipeLengthM: c.pipeLengthM,
    brazedJoints: c.brazedJoints,
    brazingMethod: c.brazingMethod,
    nitrogenPurged: c.nitrogenPurged,
    flushedPipeM: c.flushedPipeM,
    pressureTested: c.pressureTested,
    recoveredG: c.recoveredG,
    confirmedCauseId: c.confirmedCauseId,
    rootCause: c.rootCause,
    resolution: c.resolution,
    serviceCharge: c.serviceCharge,
    customerFeedback: c.customerFeedback,
    leakPoints: c.leakPoints,
    supplyVoltage: c.supplyVoltage,
    stabiliser: c.stabiliser,
    powerSource: c.powerSource,
  };
}

function MaterialsCard({
  c,
  usage,
  items,
}: {
  c: Complaint;
  usage: Awaited<ReturnType<typeof materialUsage>> | undefined;
  items: import('../db/types').InventoryItem[] | undefined;
}) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [itemId, setItemId] = useState<string>('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const item = items?.find((i) => i.id === itemId);
  const plan = item && GAS_TYPES.includes(item.type) ? issuePlan(item, c, settings.norms) : undefined;
  const used = usage?.find((u) => u.item.id === itemId)?.qty ?? 0;
  const q = Number(qty);
  const over = !!plan && q > 0 && used + q > plan.limit;

  // Gases the job is likely to need, shown as a budget the store issues against.
  const budget = useMemo(() => {
    if (!items) return [];
    return items
      .filter((i) => GAS_TYPES.includes(i.type))
      .filter((i) => i.type !== 'Refrigerant' || !c.equipment.refrigerant || i.refrigerant === c.equipment.refrigerant)
      .filter((i) => !(i.brazingMethod && c.brazingMethod && i.brazingMethod !== c.brazingMethod) || (usage?.some((u) => u.item.id === i.id) ?? false))
      .map((i) => ({ item: i, plan: issuePlan(i, c, settings.norms), used: usage?.find((u) => u.item.id === i.id)?.qty ?? 0 }))
      .filter((b) => (b.plan && b.plan.expected > 0) || b.used > 0);
  }, [items, c, settings.norms, usage]);

  const issue = (e: FormEvent) => {
    e.preventDefault();
    if (!itemId) return;
    run(async () => {
      await issueToComplaint(db, settings, c.id, itemId, q, reason.trim() || undefined);
      setQty('');
      setReason('');
    }, 'Issued');
  };

  return (
    <div className="card">
      <h2>Spares, gas &amp; consumables</h2>
      {budget.length > 0 && (
        <>
          <h3>Gas budget for this job</h3>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Budget</th>
                  <th className="num">Used</th>
                  <th style={{ width: '30%' }}></th>
                </tr>
              </thead>
              <tbody>
                {budget.map((b) => {
                  const pct = b.plan && b.plan.expected > 0 ? (b.used / b.plan.expected) * 100 : b.used > 0 ? 200 : 0;
                  const tone = b.plan && b.used > b.plan.limit ? 'bad' : pct > 100 ? 'warn' : '';
                  return (
                    <tr key={b.item.id} title={b.plan?.breakdown.join('\n')}>
                      <td>{b.item.name}</td>
                      <td className="num">
                        {b.plan ? fmtNum(b.plan.expected, 3) : '—'} {b.item.unit}
                      </td>
                      <td className="num">
                        {fmtNum(b.used, 3)} {b.item.unit}
                      </td>
                      <td>
                        <div className={`bar ${tone}`}>
                          <span style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Budgets update as you record the job type, pipe length, joints, flushing and pressure test. Returns of unused gas reduce “Used”.
          </p>
        </>
      )}

      <form onSubmit={issue} className="form-grid" style={{ marginTop: 8 }}>
        <label className="field span-all">
          Issue from store
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Select item…</option>
            {items?.map((i) => (
              <option key={i.id} value={i.id} disabled={i.stock <= 0}>
                {i.name} — {fmtNum(i.stock, 3)} {i.unit} in stock
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Quantity {item && `(${item.unit})`}
          <input type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
          {plan && (
            <span className="hint">
              Recommended: {fmtNum(Math.max(0, plan.expected - used), 3)} {plan.unit} (limit {fmtNum(plan.limit, 3)} {plan.unit} in total)
            </span>
          )}
        </label>
        <label className="field">
          {over ? 'Reason for issuing over budget *' : 'Note'}
          <input value={reason} onChange={(e) => setReason(e.target.value)} required={over} placeholder={over ? 'e.g. long pipe run, second leak found' : ''} />
        </label>
        <div className="span-all">
          {over && <p className="error">This goes over the gas budget for this job. A reason is required and will be flagged for review.</p>}
          <button type="submit" className="primary" disabled={busy || !itemId || !(q > 0)}>
            Issue
          </button>
        </div>
      </form>

      {usesRefrigerant(c.equipment.category) && <CylinderPanel c={c} />}

      <h3 style={{ marginTop: 16 }}>Used on this job</h3>
      {!usage?.length ? (
        <Empty>Nothing issued yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num hide-mobile">Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.item.id}>
                  <td>
                    <Link to={`/inventory/${u.item.id}`}>{u.item.name}</Link>
                  </td>
                  <td className="num">
                    {fmtNum(u.qty, 3)} {u.item.unit}
                  </td>
                  <td className="num hide-mobile">{fmtNum(u.qty * u.item.unitCost, 0)}</td>
                  <td className="right">
                    <button
                      className="sm"
                      disabled={busy}
                      onClick={() => {
                        const v = prompt(`Return how much ${u.item.name} (${u.item.unit}) to store?`, String(u.qty));
                        if (v) run(() => returnFromComplaint(db, settings, c.id, u.item.id, Number(v)), 'Returned to store');
                      }}
                    >
                      Return
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CustomerContactCard({ complaintId }: { complaintId: string }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [outcome, setOutcome] = useState<CallOutcome>('Customer reached');
  const [text, setText] = useState('');
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await logCustomerContact(db, settings, complaintId, outcome, text);
          setText('');
        }, 'Customer call logged');
      }}
    >
      <h2>Customer call</h2>
      <div className="form-grid">
        <label className="field span-all">
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)}>
            {CALL_OUTCOMES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="field span-all">
          Customer's response
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What the customer said" />
        </label>
      </div>
      <button type="submit" disabled={busy} style={{ marginTop: 10 }}>
        Log call
      </button>
    </form>
  );
}

function NoteCard({ complaintId }: { complaintId: string }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [text, setText] = useState('');
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        run(async () => {
          await addLog(db, complaintId, 'note', text.trim(), settings);
          setText('');
        });
      }}
    >
      <h2>Internal note</h2>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Visible to the service team only" />
      <button type="submit" disabled={busy || !text.trim()} style={{ marginTop: 10 }}>
        Add note
      </button>
    </form>
  );
}

/** Pre-written customer messages sent from the helpdesk phone via WhatsApp or SMS. */
function CustomerUpdateCard({ c, customerName, phone, techName }: { c: Complaint; customerName: string; phone: string; techName?: string }) {
  const settings = useSettings();
  const toast = useToast();
  // Customer links need the shared server; older complaints get their link token on first view.
  const links = runtime.cloud && !isTempTicket(c.ticketNo);
  useEffect(() => {
    if (links && !c.publicToken) void ensurePublicToken(db, c.id);
  }, [links, c.id, c.publicToken]);
  const track = links && c.publicToken ? trackLink(c.publicToken) : undefined;
  const rate = links && c.publicToken ? feedbackLink(c.publicToken) : undefined;
  const templates: Record<string, string> = {
    Registered: `Dear ${customerName}, your service request ${c.ticketNo} for your ${c.equipment.brand} ${c.equipment.category} has been registered with ${settings.companyName}. We will contact you to arrange a visit.${track ? ` Follow its progress here: ${track}` : ''}`,
    'Technician assigned': `Dear ${customerName}, technician ${techName ?? ''} has been assigned to your request ${c.ticketNo}${c.preferredVisit ? ` and will visit ${c.preferredVisit}` : ''}. Thank you for choosing ${settings.companyName}.${track ? ` Progress: ${track}` : ''}`,
    'Awaiting parts': `Dear ${customerName}, the parts for your request ${c.ticketNo} have been ordered. We will update you as soon as they arrive.${track ? ` Progress: ${track}` : ''}`,
    'Job completed': rate
      ? `Dear ${customerName}, the work on your request ${c.ticketNo} is complete. Please tell us how we did (it takes 10 seconds): ${rate} Thank you, ${settings.companyName}.`
      : `Dear ${customerName}, the work on your request ${c.ticketNo} is complete. Please reply with a rating from 1 (poor) to 5 (excellent) for our service. Thank you, ${settings.companyName}.`,
  };
  const copy = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast('Copy failed: select the link and copy it by hand'),
    );
  const [key, setKey] = useState(Object.keys(templates)[0]);
  const [text, setText] = useState('');
  const message = text || templates[key];
  const intl = toInternational(phone, settings.countryCode);
  const log = (via: string) => void logCustomerContact(db, settings, c.id, 'Customer reached', `${via} update sent: “${message}”`);
  return (
    <div className="card">
      <h2>Send customer update</h2>
      <label className="field">
        Message
        <select
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setText('');
          }}
        >
          {Object.keys(templates).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <textarea style={{ marginTop: 8 }} value={message} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <a className="btn" href={`https://wa.me/${intl}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer" onClick={() => log('WhatsApp')}>
          WhatsApp
        </a>
        <a className="btn" href={`sms:+${intl}?body=${encodeURIComponent(message)}`} onClick={() => log('SMS')}>
          SMS
        </a>
      </div>
      {track && rate && (
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Customer links:{' '}
          <button className="link small" onClick={() => copy(track, 'Tracking link')}>
            copy tracking link
          </button>{' '}
          ·{' '}
          <button className="link small" onClick={() => copy(rate, 'Rating link')}>
            copy rating link
          </button>
          {c.feedbackVia === 'customer' && <> · customer has rated {c.customerFeedback}★</>}
        </p>
      )}
    </div>
  );
}


/** Warranty status with the invoice details, which can be added or corrected later. */
function InvoiceWarranty({ c }: { c: Complaint }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(c.equipment.purchaseDate ?? '');
  const [invoiceNo, setInvoiceNo] = useState(c.equipment.invoiceNo ?? '');
  const onDay = new Date(c.createdAt);
  const w = warrantyFor(c.equipment, settings.warrantyRules, onDay);

  const save = () =>
    run(async () => {
      const eq = { ...c.equipment, purchaseDate: date || undefined, invoiceNo: invoiceNo || undefined };
      await updateJobDetails(db, settings, c.id, { equipment: applyWarranty(eq, settings.warrantyRules, onDay) });
      setEditing(false);
    }, 'Invoice details saved');

  if (editing) {
    return (
      <div className="stack" style={{ marginTop: 4 }}>
        <label className="field">
          Invoice date
          <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          Invoice no.
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </label>
        <div className="row">
          <button className="sm primary" disabled={busy} onClick={save}>
            Save
          </button>
          <button className="sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {c.equipment.warranty === 'AMC' ? <span className="badge primary">AMC</span> : <WarrantyNote w={w} />}
      <div className="small muted">
        {c.equipment.purchaseDate ? `Invoice ${fmtDate(c.equipment.purchaseDate)}` : 'No invoice date'}
        {c.equipment.invoiceNo && ` · No. ${c.equipment.invoiceNo}`}{' '}
        <button className="link small" onClick={() => setEditing(true)}>
          {c.equipment.purchaseDate ? 'Edit' : 'Add invoice'}
        </button>
      </div>
    </>
  );
}

/** Book or move the technician's visit. */
function VisitCard({ c }: { c: Complaint }) {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [date, setDate] = useState(c.visitDate ?? '');
  const [slot, setSlot] = useState<VisitSlot>(c.visitSlot ?? VISIT_SLOTS[0]);
  useEffect(() => {
    setDate(c.visitDate ?? '');
    setSlot(c.visitSlot ?? VISIT_SLOTS[0]);
  }, [c.visitDate, c.visitSlot]);
  const missed = isMissedVisit(c);
  const changed = date !== (c.visitDate ?? '') || slot !== c.visitSlot;
  return (
    <div className="card">
      <h2>Visit</h2>
      {c.visitDate ? (
        <p className="small" style={{ marginTop: 0 }}>
          Booked for <strong>{new Date(`${c.visitDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>,{' '}
          {c.visitSlot}
          {missed && <span className="badge bad" style={{ marginLeft: 6 }}>Missed</span>}
          {c.visitRemindedAt && <span className="muted"> · customer reminded</span>}
        </p>
      ) : (
        <p className="small muted" style={{ marginTop: 0 }}>
          No visit booked{c.preferredVisit ? `. Customer prefers: ${c.preferredVisit}` : ''}.
        </p>
      )}
      <div className="row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ flex: '1 1 140px' }} />
        <select value={slot} onChange={(e) => setSlot(e.target.value as VisitSlot)} style={{ flex: '1 1 150px' }}>
          {VISIT_SLOTS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button
          className="sm primary"
          disabled={busy || !date || !changed}
          onClick={() => {
            const reason = c.visitDate ? prompt('Reason for moving the visit? (optional)') ?? undefined : undefined;
            run(() => scheduleVisit(db, settings, c.id, { date, slot, reason }), c.visitDate ? 'Visit moved' : 'Visit booked');
          }}
        >
          {c.visitDate ? 'Move' : 'Book'}
        </button>
      </div>
    </div>
  );
}
