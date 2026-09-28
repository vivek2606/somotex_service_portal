import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { fmtDate, fmtDateTime, fmtNum, Loading } from '../components/ui';
import { db } from '../db/db';
import { confirmedCauseCounts, materialUsage } from '../db/service';
import { GAS_TYPES } from '../db/types';
import { issuePlan, usesRefrigerant } from '../lib/consumption';
import { diagnose, questionnaire } from '../lib/diagnosis';

/** Printable job card the technician takes to site. */
export default function JobCard() {
  const id = useParams().id ?? '';
  const settings = useSettings();
  const data = useLiveQuery(async () => {
    const c = await db.complaints.get(id);
    if (!c) return undefined;
    const [customer, tech, items, usage, confirmed] = await Promise.all([
      db.customers.get(c.customerId),
      c.technicianId ? db.technicians.get(c.technicianId) : undefined,
      db.items.filter((i) => i.active && GAS_TYPES.includes(i.type)).toArray(),
      materialUsage(db, id),
      confirmedCauseCounts(db),
    ]);
    return { c, customer, tech, items, usage, confirmed };
  }, [id]);

  const diagnosis = useMemo(
    () =>
      data &&
      diagnose(
        data.c.equipment.category,
        data.c.diagnosis?.answers ?? {},
        `${data.c.complaintType} ${data.c.customerStatement ?? ''} ${data.c.description}`,
        data.confirmed,
        3,
      ),
    [data],
  );

  if (!data || !diagnosis) return <Loading />;
  const { c, customer, tech, items, usage } = data;
  const gas = usesRefrigerant(c.equipment.category);
  const budget = items
    .filter((i) => i.type !== 'Refrigerant' || i.refrigerant === c.equipment.refrigerant)
    .filter((i) => !(i.brazingMethod && c.brazingMethod && i.brazingMethod !== c.brazingMethod))
    .map((i) => ({ item: i, plan: issuePlan(i, c, settings.norms) }))
    .filter((b) => b.plan && b.plan.expected > 0);
  const answers = questionnaire(c.equipment.category).filter((q) => c.diagnosis?.answers[q.id]);
  const carry = [...new Set(diagnosis.suggestions.flatMap((s) => s.cause.carry ?? []))];
  const line = <div style={{ borderBottom: '1px solid var(--border)', height: 26 }} />;

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="topbar no-print">
        <Link to={`/complaints/${id}`}>← Back to complaint</Link>
        <span className="spacer" />
        <button className="primary" onClick={() => window.print()}>
          Print job card
        </button>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <h1>{settings.companyName} · Service job card</h1>
            <div className="muted small">Printed {fmtDateTime(new Date().toISOString())}</div>
          </div>
          <div className="right">
            <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{c.ticketNo}</div>
            <div className="small">
              {c.branch && `${c.branch} · `}Priority {c.priority} · due {fmtDateTime(c.dueAt)}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="grid cols-2">
          <div>
            <h3>Customer</h3>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{customer?.name}</dd>
              <dt>Phone</dt>
              <dd>
                {customer?.phone}
                {customer?.altPhone && ` / ${customer.altPhone}`}
              </dd>
              <dt>Address</dt>
              <dd>{[customer?.address, customer?.city].filter(Boolean).join(', ')}</dd>
              {c.preferredVisit && (
                <>
                  <dt>Visit</dt>
                  <dd>{c.preferredVisit}</dd>
                </>
              )}
            </dl>
          </div>
          <div>
            <h3>Product</h3>
            <dl className="kv">
              <dt>Unit</dt>
              <dd>
                {c.equipment.brand} {c.equipment.category}
              </dd>
              <dt>Model / S/N</dt>
              <dd>
                {c.equipment.model || '—'} / {c.equipment.serialNo || '—'}
              </dd>
              {c.equipment.capacity && (
                <>
                  <dt>Capacity</dt>
                  <dd>
                    {fmtNum(c.equipment.capacity)} {c.equipment.capacityUnit} {c.equipment.refrigerant && c.equipment.refrigerant !== 'None' && `· ${c.equipment.refrigerant}`}
                    {c.equipment.nameplateChargeG && ` · nameplate ${c.equipment.nameplateChargeG} g`}
                  </dd>
                </>
              )}
              <dt>Warranty</dt>
              <dd>
                {c.equipment.warranty}
                {c.equipment.purchaseDate && ` · bought ${fmtDate(c.equipment.purchaseDate)}`}
              </dd>
              <dt>Technician</dt>
              <dd>{tech?.name ?? '—'}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Problem: {c.complaintType}</h3>
        {c.customerStatement && <blockquote>“{c.customerStatement}”</blockquote>}
        {c.description && <p style={{ marginTop: 8 }}>{c.description}</p>}
        {answers.length > 0 && (
          <dl className="kv small" style={{ marginTop: 8 }}>
            {answers.map((q) => (
              <FragmentKV key={q.id} k={q.text} v={c.diagnosis!.answers[q.id]} />
            ))}
          </dl>
        )}
      </div>

      {diagnosis.suggestions.length > 0 && (
        <div className="card">
          <h3>Likely causes: check in this order</h3>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {diagnosis.suggestions.map((s) => (
              <li key={s.cause.id} style={{ marginBottom: 6 }}>
                <strong>{s.cause.name}</strong> ({s.likelihood}%): {s.cause.check}
              </li>
            ))}
          </ol>
          {carry.length > 0 && (
            <p style={{ marginTop: 8 }}>
              <strong>Carry:</strong> {carry.join(', ')}
            </p>
          )}
        </div>
      )}

      {gas && (
        <div className="card">
          <h3>Gas budget &amp; usage</h3>
          <p className="small muted">
            Weigh refrigerant cylinders before and after the job. Issue more than the budget only with a reason. Return unused gas to the
            store.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Gas</th>
                  <th className="num">Budget</th>
                  <th className="num">Issued</th>
                  <th>Cylinder before</th>
                  <th>Cylinder after</th>
                  <th>Used</th>
                </tr>
              </thead>
              <tbody>
                {budget.map((b) => (
                  <tr key={b.item.id}>
                    <td>{b.item.name}</td>
                    <td className="num">
                      {fmtNum(b.plan!.expected, 3)} {b.item.unit}
                    </td>
                    <td className="num">{fmtNum(usage.find((u) => u.item.id === b.item.id)?.qty ?? 0, 3)}</td>
                    <td></td>
                    <td></td>
                    <td></td>
                  </tr>
                ))}
                {budget.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted small">
                      {c.jobType ? `No gas is budgeted for “${c.jobType}”.` : 'Budgets appear once the job type is recorded.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="grid cols-3" style={{ marginTop: 12 }}>
            <div>
              Pipe length (m){line}
            </div>
            <div>
              Brazed joints / method{line}
            </div>
            <div>
              N₂ purge / pressure test (bar){line}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Technician's report</h3>
        <div className="stack">
          <div>
            Findings / root cause{line}
            {line}
          </div>
          <div>
            Work done{line}
            {line}
          </div>
          <div>
            Spares used{line}
          </div>
          <div className="grid cols-3">
            <div>
              Time in{line}
            </div>
            <div>
              Time out{line}
            </div>
            <div>
              Customer rating (1–5){line}
            </div>
          </div>
          <div className="grid cols-2">
            <div>
              Customer name &amp; signature{line}
            </div>
            <div>
              Technician signature{line}
            </div>
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
