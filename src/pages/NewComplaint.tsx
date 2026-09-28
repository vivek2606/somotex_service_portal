import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Questionnaire, SuggestionPanel } from '../components/Diagnosis';
import { useSettings } from '../components/SettingsContext';
import { fmtDateTime, useAction } from '../components/ui';
import { db } from '../db/db';
import { addLog, confirmedCauseCounts, createComplaint, OPEN_STATUSES } from '../db/service';
import type {
  CapacityUnit,
  Complaint,
  Customer,
  Equipment,
  Priority,
  ProductCategory,
  Refrigerant,
  WarrantyStatus,
} from '../db/types';
import { REFRIGERANTS } from '../db/types';
import { usesRefrigerant } from '../lib/consumption';
import { diagnose, type Answers } from '../lib/diagnosis';

const CAP_UNITS: CapacityUnit[] = ['BTU/h', 'TR', 'kW', 'HP', 'L'];
const PRIORITIES: Priority[] = ['Low', 'Normal', 'High', 'Critical'];
const SOURCES: Complaint['source'][] = ['Phone', 'Walk-in', 'Dealer', 'Email', 'WhatsApp', 'Other'];

const blankCustomer = { name: '', phone: '', altPhone: '', email: '', address: '', city: '', type: 'Individual' as Customer['type'] };

function defaultUnit(cat: ProductCategory): CapacityUnit {
  if (cat === 'Refrigerator' || cat === 'Chest Freezer') return 'L';
  if (cat === 'VRF / VRV' || cat === 'Chiller' || cat === 'Commercial AC') return 'kW';
  return 'BTU/h';
}

function warrantyFromDate(date: string): WarrantyStatus {
  if (!date) return 'Unknown';
  const months = (Date.now() - new Date(date).getTime()) / (30.44 * 86400000);
  return months <= 12 ? 'In Warranty' : 'Out of Warranty';
}

export default function NewComplaint() {
  const settings = useSettings();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run, busy } = useAction();

  const [customerId, setCustomerId] = useState<string | undefined>(params.get('customer') ?? undefined);
  const [cust, setCust] = useState(blankCustomer);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const [caller, setCaller] = useState({ callerName: '', callerPhone: '', source: 'Phone' as Complaint['source'] });
  const [eq, setEq] = useState<Equipment>({
    brand: settings.brands[0]?.name ?? '',
    category: 'Residential AC',
    model: '',
    serialNo: '',
    capacityUnit: 'BTU/h',
    refrigerant: 'R32',
    warranty: 'Unknown',
  });
  const [complaintType, setComplaintType] = useState(settings.complaintTypes[0]);
  const [statement, setStatement] = useState('');
  const [description, setDescription] = useState('');
  const [answers, setAnswers] = useState<Answers>({});
  const [priority, setPriority] = useState<Priority | ''>('');
  const [preferredVisit, setPreferredVisit] = useState('');
  const [technicianId, setTechnicianId] = useState<string>('');

  const selectedCustomer = useLiveQuery(() => (customerId ? db.customers.get(customerId) : undefined), [customerId]);
  const matches = useLiveQuery(async () => {
    const q = deferredSearch.trim().toLowerCase();
    if (q.length < 2) return [];
    const digits = q.replace(/\D/g, '');
    return db.customers
      .filter((c) => c.name.toLowerCase().includes(q) || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)))
      .limit(8)
      .toArray();
  }, [deferredSearch]);
  const pastUnits = useLiveQuery(async () => {
    if (!customerId) return [];
    const list = await db.complaints.where('customerId').equals(customerId).reverse().sortBy('createdAt');
    const seen = new Set<string>();
    return list
      .map((c) => c.equipment)
      .filter((e) => {
        const k = `${e.brand}|${e.model}|${e.serialNo}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }, [customerId]);
  const technicians = useLiveQuery(() => db.technicians.filter((t) => t.active).toArray(), []);
  const confirmed = useLiveQuery(() => confirmedCauseCounts(db), []);
  const [allowDuplicate, setAllowDuplicate] = useState(false);

  // Warn before a second complaint is opened for the same customer or unit.
  const phoneDigits = useDeferredValue((selectedCustomer?.phone ?? cust.phone).replace(/\D/g, ''));
  const serial = useDeferredValue(eq.serialNo.trim().toLowerCase());
  const matches2 = useLiveQuery(async () => {
    const phoneKey = phoneDigits.length >= 7 ? phoneDigits.slice(-9) : '';
    if (!customerId && !phoneKey && serial.length < 3) return { open: [], recent: [] };
    const open = await db.complaints.where('status').anyOf(OPEN_STATUSES).toArray();
    const custIds = new Set(open.map((c) => c.customerId));
    const customers = new Map((await db.customers.bulkGet([...custIds])).filter(Boolean).map((c) => [c!.id, c!]));
    const sameUnit = (c: Complaint) => serial.length >= 3 && c.equipment.serialNo.trim().toLowerCase() === serial;
    const sameCustomer = (c: Complaint) =>
      (customerId && c.customerId === customerId) ||
      (phoneKey && (customers.get(c.customerId)?.phone.replace(/\D/g, '') ?? '').endsWith(phoneKey));
    const openMatches = open
      .filter((c) => sameUnit(c) || sameCustomer(c))
      .map((c) => ({ c, customer: customers.get(c.customerId), sameUnit: sameUnit(c) }));
    // Same unit closed recently: likely a repeat visit (rework).
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const recent =
      serial.length >= 3
        ? (await db.complaints.where('equipment.serialNo').equals(eq.serialNo.trim()).toArray()).filter(
            (c) => c.status === 'Closed' && (c.closedAt ?? '') >= since,
          )
        : [];
    return { open: openMatches, recent };
  }, [customerId, phoneDigits, serial]);
  const duplicates = matches2?.open ?? [];
  const recentVisits = matches2?.recent ?? [];

  const customerText = `${complaintType} ${statement} ${description} ${Object.values(answers).join(' ')}`;
  const deferredText = useDeferredValue(customerText);
  const diagnosis = useMemo(
    () => diagnose(eq.category, answers, deferredText, confirmed ?? {}),
    [eq.category, answers, deferredText, confirmed],
  );
  const effectivePriority: Priority = priority || diagnosis.priority || 'Normal';
  const inHouse = settings.brands.find((b) => b.name === eq.brand)?.inHouse;

  const setCategory = (category: ProductCategory) => {
    setEq((e) => ({
      ...e,
      category,
      capacityUnit: defaultUnit(category),
      refrigerant: usesRefrigerant(category) ? (category === 'Refrigerator' || category === 'Chest Freezer' ? 'R600a' : 'R32') : 'None',
    }));
    setAnswers({});
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!customerId && (!cust.name.trim() || !cust.phone.trim())) throw new Error('Enter the customer name and phone');
      if (duplicates.length && !allowDuplicate) {
        throw new Error(`${duplicates[0].c.ticketNo} is already open for this customer or unit. Open it instead, or tick the box to confirm this is a separate problem.`);
      }
      const id = await createComplaint(db, settings, {
        customerId,
        customer: customerId ? undefined : { ...cust, name: cust.name.trim(), phone: cust.phone.trim() },
        equipment: eq,
        complaintType,
        description: description.trim(),
        customerStatement: statement.trim() || undefined,
        callerName: caller.callerName.trim() || undefined,
        callerPhone: caller.callerPhone.trim() || undefined,
        preferredVisit: preferredVisit.trim() || undefined,
        source: caller.source,
        priority: effectivePriority,
        technicianId: technicianId || undefined,
        diagnosis: {
          answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v)),
          suggested: diagnosis.suggestions.map((s) => ({ causeId: s.cause.id, likelihood: s.likelihood })),
        },
      });
      if (duplicates.length) {
        await addLog(db, id, 'note', `Registered although ${duplicates.map((d) => d.c.ticketNo).join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} open for the same customer or unit`, settings);
      }
      if (recentVisits.length) {
        await addLog(db, id, 'note', `Repeat visit: this unit was closed under ${recentVisits.map((c) => c.ticketNo).join(', ')} within the last 30 days`, settings);
      }
      navigate(`/complaints/${id}`, { replace: true });
    }, 'Complaint registered');
  };

  const num = (v: string) => (v === '' ? undefined : Number(v));

  return (
    <form onSubmit={submit}>
      <div className="topbar">
        <h1>New complaint</h1>
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy}>
          Register complaint
        </button>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <fieldset>
            <legend>Customer</legend>
            {selectedCustomer ? (
              <div className="row between">
                <div>
                  <strong>{selectedCustomer.name}</strong> · {selectedCustomer.phone}
                  <div className="small muted">{selectedCustomer.address}</div>
                </div>
                <button type="button" className="sm" onClick={() => setCustomerId(undefined)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <label className="field">
                  Find an existing customer
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name or phone number"
                  />
                </label>
                {!!matches?.length && (
                  <div className="card" style={{ padding: 0, margin: '8px 0', boxShadow: 'none' }}>
                    {matches.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        className="link"
                        style={{ display: 'block', padding: '8px 12px', width: '100%', textAlign: 'left' }}
                        onClick={() => {
                          setCustomerId(m.id);
                          setSearch('');
                        }}
                      >
                        {m.name} · {m.phone} <span className="muted small">{m.city}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="small muted" style={{ margin: '10px 0' }}>
                  Or enter a new customer:
                </p>
                <div className="form-grid">
                  <label className="field">
                    Name *
                    <input value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
                  </label>
                  <label className="field">
                    Phone *
                    <input type="tel" value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
                  </label>
                  <label className="field">
                    Alternate phone
                    <input type="tel" value={cust.altPhone} onChange={(e) => setCust({ ...cust, altPhone: e.target.value })} />
                  </label>
                  <label className="field">
                    Type
                    <select value={cust.type} onChange={(e) => setCust({ ...cust, type: e.target.value as Customer['type'] })}>
                      <option>Individual</option>
                      <option>Business</option>
                      <option>Dealer</option>
                    </select>
                  </label>
                  <label className="field span-all">
                    Address / location
                    <input value={cust.address} onChange={(e) => setCust({ ...cust, address: e.target.value })} />
                  </label>
                  <label className="field">
                    City / town
                    <input value={cust.city} onChange={(e) => setCust({ ...cust, city: e.target.value })} />
                  </label>
                  <label className="field">
                    Email
                    <input type="email" value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} />
                  </label>
                </div>
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>Call details</legend>
            <div className="form-grid">
              <label className="field">
                Received via
                <select value={caller.source} onChange={(e) => setCaller({ ...caller, source: e.target.value as Complaint['source'] })}>
                  {SOURCES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Caller name <span className="hint">if not the customer</span>
                <input value={caller.callerName} onChange={(e) => setCaller({ ...caller, callerName: e.target.value })} />
              </label>
              <label className="field">
                Caller phone
                <input type="tel" value={caller.callerPhone} onChange={(e) => setCaller({ ...caller, callerPhone: e.target.value })} />
              </label>
              <label className="field">
                Customer's preferred visit time
                <input value={preferredVisit} onChange={(e) => setPreferredVisit(e.target.value)} placeholder="e.g. Tue after 2 pm" />
              </label>
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Logged by <strong>{settings.currentUser}</strong>
            </p>
          </fieldset>

          <fieldset>
            <legend>Product</legend>
            {!!pastUnits?.length && (
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="small muted">Customer's units:</span>
                {pastUnits.map((u) => (
                  <button type="button" className="sm" key={`${u.brand}${u.model}${u.serialNo}`} onClick={() => setEq({ ...u })}>
                    {u.brand} {u.model || u.category}
                  </button>
                ))}
              </div>
            )}
            <div className="form-grid">
              <label className="field">
                Brand {inHouse && <span className="badge primary">In-house</span>}
                <select value={eq.brand} onChange={(e) => setEq({ ...eq, brand: e.target.value })}>
                  {settings.brands.map((b) => (
                    <option key={b.name}>{b.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Category
                <select value={eq.category} onChange={(e) => setCategory(e.target.value as ProductCategory)}>
                  {settings.categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Model
                <input value={eq.model} onChange={(e) => setEq({ ...eq, model: e.target.value })} />
              </label>
              <label className="field">
                Serial no.
                <input value={eq.serialNo} onChange={(e) => setEq({ ...eq, serialNo: e.target.value })} />
              </label>
              {usesRefrigerant(eq.category) && (
                <>
                  <label className="field">
                    Capacity
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={eq.capacity ?? ''}
                        onChange={(e) => setEq({ ...eq, capacity: num(e.target.value) })}
                      />
                      <select
                        style={{ width: 90 }}
                        value={eq.capacityUnit}
                        onChange={(e) => setEq({ ...eq, capacityUnit: e.target.value as CapacityUnit })}
                      >
                        {CAP_UNITS.map((u) => (
                          <option key={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                  </label>
                  <label className="field">
                    Refrigerant
                    <select value={eq.refrigerant} onChange={(e) => setEq({ ...eq, refrigerant: e.target.value as Refrigerant })}>
                      {[...REFRIGERANTS, 'None'].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Nameplate charge (g) <span className="hint">improves gas checks</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      value={eq.nameplateChargeG ?? ''}
                      onChange={(e) => setEq({ ...eq, nameplateChargeG: num(e.target.value) })}
                    />
                  </label>
                </>
              )}
              <label className="field">
                Purchase date
                <input
                  type="date"
                  value={eq.purchaseDate ?? ''}
                  onChange={(e) =>
                    setEq({ ...eq, purchaseDate: e.target.value, warranty: warrantyFromDate(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                Warranty
                <select value={eq.warranty} onChange={(e) => setEq({ ...eq, warranty: e.target.value as WarrantyStatus })}>
                  <option>In Warranty</option>
                  <option>Out of Warranty</option>
                  <option>AMC</option>
                  <option>Unknown</option>
                </select>
              </label>
              <label className="field">
                Invoice no.
                <input value={eq.invoiceNo ?? ''} onChange={(e) => setEq({ ...eq, invoiceNo: e.target.value })} />
              </label>
              <label className="field">
                Dealer
                <input value={eq.dealer ?? ''} onChange={(e) => setEq({ ...eq, dealer: e.target.value })} />
              </label>
            </div>
          </fieldset>
        </div>

        <div className="stack">
          <fieldset>
            <legend>Problem, in the customer's words</legend>
            <div className="form-grid">
              <label className="field span-all">
                Complaint type
                <select value={complaintType} onChange={(e) => setComplaintType(e.target.value)}>
                  {settings.complaintTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="field span-all">
                What the customer said
                <textarea
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder="e.g. “It was cooling fine yesterday, now only warm air comes and there is water dripping on the wall.”"
                />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Questions to ask</legend>
            <Questionnaire category={eq.category} answers={answers} onChange={setAnswers} />
          </fieldset>

          <fieldset>
            <legend>Likely causes</legend>
            <SuggestionPanel diagnosis={diagnosis} />
          </fieldset>

          {(duplicates.length > 0 || recentVisits.length > 0) && (
            <fieldset style={{ borderColor: 'var(--warn)' }}>
              <legend>Check before registering</legend>
              {duplicates.map(({ c, customer, sameUnit }) => (
                <div key={c.id} className="alert-box" style={{ marginBottom: 8 }}>
                  <strong>
                    <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link> is already open
                  </strong>{' '}
                  for {sameUnit ? 'this unit' : 'this customer'} ({customer?.name}): {c.equipment.brand} {c.equipment.category} · {c.complaintType} · {c.status}
                  <div className="small">
                    Logged {fmtDateTime(c.createdAt)} by {c.loggedBy}
                    {c.loggedByEmail && ` (${c.loggedByEmail})`}
                  </div>
                </div>
              ))}
              {recentVisits.map((c) => (
                <div key={c.id} className="alert-box info" style={{ marginBottom: 8 }}>
                  <strong>Repeat visit?</strong> This unit was closed under <Link to={`/complaints/${c.id}`}>{c.ticketNo}</Link> on{' '}
                  {fmtDateTime(c.closedAt)} by {c.closedBy ?? '—'}
                  {c.closedByEmail && ` (${c.closedByEmail})`}. Consider re-opening it instead if it's the same fault.
                </div>
              ))}
              {duplicates.length > 0 && (
                <label className="field inline">
                  <input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
                  This is a separate problem: register a new complaint anyway
                </label>
              )}
            </fieldset>
          )}

          <fieldset>
            <legend>Dispatch</legend>
            <div className="form-grid">
              <label className="field">
                Priority {!priority && diagnosis.priority && <span className="hint">suggested</span>}
                <select value={effectivePriority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Assign technician
                <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
                  <option value="">Not yet</option>
                  {technicians?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field span-all">
                Helpdesk notes
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Anything else the technician should know" />
              </label>
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Target resolution: {settings.slaHours[effectivePriority]} h ({effectivePriority})
            </p>
          </fieldset>
          <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
            Register complaint
          </button>
        </div>
      </div>
    </form>
  );
}
