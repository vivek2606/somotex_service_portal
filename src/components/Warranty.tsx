import type { WarrantyResult } from '../lib/warranty';
import { fmtDate } from './ui';

/** One-line explanation of a warranty result, for the helpdesk. */
export function WarrantyNote({ w }: { w: WarrantyResult }) {
  if (w.status === 'Unknown') {
    return <span className="muted">Ask the customer for the invoice date to confirm warranty.</span>;
  }
  const inW = w.status === 'In Warranty';
  return (
    <span>
      <span className={`badge ${inW ? 'ok' : 'warn'}`}>{w.status}</span>{' '}
      {inW ? 'until' : 'expired'} {fmtDate(w.until)} ({w.months}-month warranty)
      {w.compressorUntil && (
        <>
          {' '}
          · compressor {w.compressorCovered ? 'covered until' : 'expired'} {fmtDate(w.compressorUntil)}
        </>
      )}
    </span>
  );
}
