// Late and urgent complaints that the Service Head should hear about.
//
// The app can't send WhatsApp messages or emails by itself; it prepares the
// message and opens WhatsApp or the mail program with one click, then
// records that the job was escalated so it isn't raised twice.

import { runtime, type ServiceDB } from './db';
import { addLog, isOpen } from './service';
import type { AppSettings } from './settings';
import type { Complaint, Customer } from './types';

export type EscalationReason = 'overdue' | 'urgent';

export interface Escalation {
  c: Complaint;
  reason: EscalationReason;
}

/** Open complaints that are late or urgent and haven't been escalated for that reason yet. */
export function pendingEscalations(complaints: Complaint[], settings: Pick<AppSettings, 'escalation'>, now = runtime.now()): Escalation[] {
  const { overdueHours, priorities } = settings.escalation;
  const out: Escalation[] = [];
  for (const c of complaints) {
    if (!isOpen(c)) continue;
    if (!c.escalatedUrgentAt && priorities.includes(c.priority)) out.push({ c, reason: 'urgent' });
    else if (!c.escalatedOverdueAt && Date.parse(c.dueAt) + overdueHours * 3600000 < now.getTime()) out.push({ c, reason: 'overdue' });
  }
  return out.sort((a, b) => a.c.dueAt.localeCompare(b.c.dueAt));
}

const hoursLate = (c: Complaint, now: Date) => Math.max(0, Math.round((now.getTime() - Date.parse(c.dueAt)) / 3600000));

/** One message listing the escalations, for WhatsApp or email. */
export function escalationMessage(
  list: Escalation[],
  customers: Map<string, Customer>,
  technicians: Map<string, string>,
  company: string,
  link: (c: Complaint) => string,
  now = runtime.now(),
): string {
  const lines = list.map(({ c, reason }) => {
    const cu = customers.get(c.customerId);
    const what = reason === 'urgent' ? `${c.priority.toUpperCase()} priority` : `OVERDUE by ${hoursLate(c, now)} h`;
    return [
      `• ${c.ticketNo} (${what}) · ${c.branch ?? 'no branch'}`,
      `  ${cu?.name ?? 'Customer'}${cu?.phone ? `, ${cu.phone}` : ''} · ${c.equipment.brand} ${c.equipment.category}: ${c.complaintType}`,
      `  Status ${c.status}${c.technicianId ? `, ${technicians.get(c.technicianId) ?? 'technician'}` : ', no technician'}`,
      `  ${link(c)}`,
    ].join('\n');
  });
  return `${company} service escalation: ${list.length} complaint${list.length === 1 ? '' : 's'} need attention\n\n${lines.join('\n\n')}`;
}

/** Records that these complaints were escalated, so they drop off the list. */
export async function markEscalated(db: ServiceDB, settings: AppSettings, list: Escalation[], via: string) {
  const at = runtime.now().toISOString();
  for (const { c, reason } of list) {
    await db.complaints.update(c.id, reason === 'urgent' ? { escalatedUrgentAt: at } : { escalatedOverdueAt: at });
    await addLog(db, c.id, 'note', `Escalated to the Service Head by ${via} (${reason === 'urgent' ? `${c.priority} priority` : 'overdue'})`, settings);
  }
}
