// Booking technician visits and spotting missed ones.

import type { ServiceDB } from './db';
import { runtime } from './db';
import { addLog, assignTechnician, getComplaint, isOpen } from './service';
import type { AppSettings } from './settings';
import { VISIT_SLOTS, type Complaint, type VisitSlot } from './types';

/** Hour of day each slot ends, to tell when a visit has been missed. */
const SLOT_END_HOUR: Record<VisitSlot, number> = {
  'Morning (8–12)': 12,
  'Afternoon (12–4)': 16,
  'Evening (4–7)': 19,
};

export const slotOrder = (s?: VisitSlot) => (s ? VISIT_SLOTS.indexOf(s) : 99);

export function visitEnd(c: Pick<Complaint, 'visitDate' | 'visitSlot'>): Date | undefined {
  if (!c.visitDate) return undefined;
  const d = new Date(`${c.visitDate}T00:00:00`);
  d.setHours(c.visitSlot ? SLOT_END_HOUR[c.visitSlot] : 19);
  return d;
}

/** Booked visit whose time has passed with no work started. */
export function isMissedVisit(c: Complaint, now = runtime.now()): boolean {
  const end = visitEnd(c);
  return !!end && end < now && (c.status === 'Registered' || c.status === 'Assigned');
}

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function scheduleVisit(
  db: ServiceDB,
  settings: AppSettings,
  complaintId: string,
  visit: { date: string; slot: VisitSlot; technicianId?: string; reason?: string },
) {
  if (!visit.date) throw new Error('Choose the visit date');
  const c = await getComplaint(db, complaintId);
  if (!isOpen(c)) throw new Error('This complaint is not open');
  if (visit.technicianId && visit.technicianId !== c.technicianId) await assignTechnician(db, settings, complaintId, visit.technicianId);
  const before = c.visitDate ? `${c.visitDate} ${c.visitSlot ?? ''}`.trim() : undefined;
  await db.complaints.update(complaintId, {
    visitDate: visit.date,
    visitSlot: visit.slot,
    visitRemindedAt: undefined,
    updatedAt: runtime.now().toISOString(),
  });
  const when = `${visit.date} ${visit.slot}`;
  await addLog(
    db,
    complaintId,
    'assignment',
    before ? `Visit moved from ${before} to ${when}${visit.reason ? ` (${visit.reason})` : ''}` : `Visit booked for ${when}`,
    settings,
  );
}

export async function markReminded(db: ServiceDB, settings: AppSettings, complaintId: string, via: string) {
  await db.complaints.update(complaintId, { visitRemindedAt: runtime.now().toISOString() });
  await addLog(db, complaintId, 'customer', `Visit reminder sent by ${via}`, settings);
}

/** Reminder text for the customer. */
export function reminderText(c: Complaint, customerName: string, techName: string | undefined, company: string) {
  const day = c.visitDate
    ? new Date(`${c.visitDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    : '';
  return `Dear ${customerName}, this is ${company}. ${techName ? `Our technician ${techName}` : 'Our technician'} will visit on ${day}, ${c.visitSlot ?? ''} for your ${c.equipment.brand} ${c.equipment.category} (ref ${c.ticketNo}). Please reply if this time does not suit you.`;
}
