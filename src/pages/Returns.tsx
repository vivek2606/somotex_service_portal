import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { ReturnActions } from '../components/PartReturns';
import { Empty, fmtDate, Loading } from '../components/ui';
import { db } from '../db/db';
import { hasReachedLagos, isReturnClosed, isReturnLate, RETURN_DUE_DAYS, stageOrder } from '../db/returns';
import type { PartReturn, ReturnStage } from '../db/types';

const STAGE_TONE: Partial<Record<ReturnStage, string>> = {
  'At site': 'warn',
  'With technician': 'warn',
  'At branch': 'info',
  'In transit to Lagos': 'primary',
  'Received in Lagos': 'ok',
  'Sent to principal': 'ok',
};

export default function Returns() {
  const settings = useSettings();
  const [filter, setFilter] = useState<'open' | 'lagos' | 'all'>('open');
  const [brand, setBrand] = useState('');
  const [open, setOpen] = useState<string>();
  const data = useLiveQuery(async () => {
    const list = await db.partReturns.toArray();
    const complaints = new Map((await db.complaints.bulkGet([...new Set(list.map((r) => r.complaintId))])).filter(Boolean).map((c) => [c!.id, c!]));
    return { list, complaints };
  }, []);
  if (!data) return <Loading />;
  const { list, complaints } = data;
  const inHouse = new Set(settings.brands.filter((b) => b.inHouse).map((b) => b.name));
  const shown = list
    .filter((r) => (filter === 'all' ? true : filter === 'open' ? !hasReachedLagos(r) : r.stage === 'Received in Lagos'))
    .filter((r) => !brand || r.brand === brand)
    .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.createdAt.localeCompare(b.createdAt));
  const late = list.filter((r) => isReturnLate(r));
  const toClaim = list.filter((r) => r.stage === 'Received in Lagos' && !inHouse.has(r.brand));

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Defective part returns</h1>
          <div className="small muted">Old parts on their way from the site to Lagos, and on to the principal for the warranty claim.</div>
        </div>
        <span className="spacer" />
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All brands</option>
          {settings.brands.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ width: 'auto' }}>
          <option value="open">Not yet in Lagos</option>
          <option value="lagos">In Lagos, not yet claimed</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="label">On the way to Lagos</div>
          <div className="value">{list.filter((r) => !hasReachedLagos(r)).length}</div>
        </div>
        <div className={`card kpi ${late.length ? 'bad' : 'ok'}`}>
          <div className="label">Not in Lagos after {RETURN_DUE_DAYS} days</div>
          <div className="value">{late.length}</div>
        </div>
        <div className={`card kpi ${toClaim.length ? 'warn' : ''}`}>
          <div className="label">In Lagos, ready to claim</div>
          <div className="value">{toClaim.length}</div>
          <div className="small muted">principal brands</div>
        </div>
        <div className="card kpi ok">
          <div className="label">Sent to principal</div>
          <div className="value">{list.filter((r) => r.stage === 'Sent to principal').length}</div>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <Empty>
            No returns here. Register a defective part from the complaint page (“Defective part return”) when a part is replaced under warranty.
          </Empty>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Return</th>
                  <th>Part</th>
                  <th>Job</th>
                  <th>Stage</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const c = complaints.get(r.complaintId);
                  return (
                    <ReturnRow key={r.id} r={r} ticket={c?.ticketNo} open={open === r.id} toggle={() => setOpen(open === r.id ? undefined : r.id)} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReturnRow({ r, ticket, open, toggle }: { r: PartReturn; ticket?: string; open: boolean; toggle: () => void }) {
  const late = isReturnLate(r);
  return (
    <>
      <tr>
        <td>
          <strong>{r.ref}</strong>
          <div className="small muted">
            {fmtDate(r.createdAt)} · {r.branch ?? '—'}
          </div>
        </td>
        <td>
          {r.partName}
          <div className="small muted">
            {r.brand}
            {r.partSerial && ` · S/N ${r.partSerial}`}
          </div>
        </td>
        <td>
          <Link to={`/complaints/${r.complaintId}`}>{ticket ?? 'job'}</Link>
        </td>
        <td>
          <span className={`badge ${late ? 'bad' : STAGE_TONE[r.stage] ?? ''}`}>{r.stage}</span>
          {r.waybill && <div className="small muted">Waybill {r.waybill}</div>}
          {r.claimRef && <div className="small muted">Claim {r.claimRef}</div>}
        </td>
        <td className="right">
          {!isReturnClosed(r) && (
            <button className="sm" onClick={toggle}>
              {open ? 'Close' : 'Update'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
            <ReturnActions r={r} onDone={toggle} />
          </td>
        </tr>
      )}
    </>
  );
}
