// Service tools: vacuum pumps, gauge sets, charging scales, brazing kits.
// Records who holds each tool and when it is due for calibration. A charging
// scale that is out of calibration makes every gas figure wrong.

import { newId, runtime, type ServiceDB } from './db';
import type { AppSettings } from './settings';
import type { Tool, ToolKind, ToolMoveKind } from './types';

const nowIso = () => runtime.now().toISOString();

/** Tools checked out longer than this are flagged. */
export const TOOL_OUT_DAYS = 7;
/** Calibration is shown as "due soon" this many days ahead. */
export const CALIBRATION_WARN_DAYS = 14;

/** Tool kinds that normally need regular calibration, with a typical interval in months. */
export const DEFAULT_CALIBRATION: Partial<Record<ToolKind, number>> = {
  'Charging scale': 12,
  'Manifold gauge set': 12,
  'Leak detector': 12,
  'Multimeter / clamp meter': 12,
};

const day = (iso: string) => iso.slice(0, 10);

/** Adds months to a YYYY-MM-DD date. */
export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export type CalibrationState = 'none' | 'ok' | 'due-soon' | 'overdue';

export function calibrationState(t: Pick<Tool, 'calibrationMonths' | 'calibrationDue' | 'status'>, now = runtime.now()): CalibrationState {
  if (!t.calibrationMonths || t.status === 'Retired') return 'none';
  if (!t.calibrationDue) return 'overdue';
  const today = day(now.toISOString());
  if (t.calibrationDue < today) return 'overdue';
  const warn = new Date(now.getTime() + CALIBRATION_WARN_DAYS * 86400000).toISOString().slice(0, 10);
  return t.calibrationDue <= warn ? 'due-soon' : 'ok';
}

export function isToolOverdue(t: Pick<Tool, 'status' | 'issuedAt'>, now = runtime.now()) {
  return t.status === 'Issued' && !!t.issuedAt && now.getTime() - Date.parse(t.issuedAt) > TOOL_OUT_DAYS * 86400000;
}

async function getTool(db: ServiceDB, id: string) {
  const t = await db.tools.get(id);
  if (!t) throw new Error('Tool not found');
  return t;
}

async function move(db: ServiceDB, settings: AppSettings, toolId: string, kind: ToolMoveKind, extra: { technicianId?: string; complaintId?: string; note?: string } = {}) {
  await db.toolMoves.add({
    id: newId(),
    toolId,
    kind,
    at: nowIso(),
    ...extra,
    note: extra.note?.trim() || undefined,
    by: settings.currentUser,
    byEmail: settings.currentUserEmail,
  });
}

export interface NewTool {
  tag: string;
  kind: ToolKind;
  description?: string;
  serialNo?: string;
  branch: string;
  calibrationMonths?: number;
  lastCalibratedAt?: string;
  notes?: string;
}

export async function registerTool(db: ServiceDB, settings: AppSettings, input: NewTool): Promise<string> {
  const tag = input.tag.trim().toUpperCase();
  if (!tag) throw new Error('Enter the tool tag');
  if (!input.branch) throw new Error('Choose the branch');
  if (await db.tools.where('tag').equals(tag).filter((t) => t.status !== 'Retired').count()) {
    throw new Error(`A tool tagged ${tag} is already registered`);
  }
  const months = input.calibrationMonths && input.calibrationMonths > 0 ? input.calibrationMonths : undefined;
  const last = input.lastCalibratedAt || undefined;
  const id = newId();
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.add({
      id,
      tag,
      kind: input.kind,
      description: input.description?.trim() || undefined,
      serialNo: input.serialNo?.trim() || undefined,
      branch: input.branch,
      status: 'In store',
      calibrationMonths: months,
      lastCalibratedAt: last,
      calibrationDue: months ? (last ? addMonths(last, months) : day(nowIso())) : undefined,
      notes: input.notes?.trim() || undefined,
      createdAt: nowIso(),
    });
    await move(db, settings, id, 'Registered', { note: input.branch });
  });
  return id;
}

export async function issueTool(db: ServiceDB, settings: AppSettings, toolId: string, technicianId: string, complaintId?: string, note?: string) {
  const t = await getTool(db, toolId);
  if (t.status !== 'In store') throw new Error(`${t.tag} is ${t.status === 'Issued' ? 'already issued' : t.status.toLowerCase()}`);
  if (!technicianId) throw new Error('Choose the technician');
  const cal = calibrationState(t);
  if (cal === 'overdue' && !note?.trim()) {
    throw new Error(`${t.tag} is overdue for calibration. Calibrate it first, or enter a reason to issue it anyway.`);
  }
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { status: 'Issued', technicianId, issuedAt: nowIso() });
    await move(db, settings, toolId, 'Issued', { technicianId, complaintId, note });
  });
}

export async function returnTool(db: ServiceDB, settings: AppSettings, toolId: string, note?: string) {
  const t = await getTool(db, toolId);
  if (t.status !== 'Issued') throw new Error(`${t.tag} is not issued`);
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { status: 'In store', technicianId: undefined, issuedAt: undefined });
    await move(db, settings, toolId, 'Returned', { technicianId: t.technicianId, note });
  });
}

/** Records a calibration (date YYYY-MM-DD, default today) and sets the next due date. */
export async function calibrateTool(db: ServiceDB, settings: AppSettings, toolId: string, date?: string, note?: string) {
  const t = await getTool(db, toolId);
  if (t.status === 'Retired') throw new Error(`${t.tag} is retired`);
  const on = date || day(nowIso());
  if (on > day(nowIso())) throw new Error('The calibration date can’t be in the future');
  const months = t.calibrationMonths ?? DEFAULT_CALIBRATION[t.kind] ?? 12;
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { lastCalibratedAt: on, calibrationMonths: months, calibrationDue: addMonths(on, months) });
    await move(db, settings, toolId, 'Calibrated', { note: [on, note?.trim()].filter(Boolean).join(' · ') });
  });
}

export async function sendToolForRepair(db: ServiceDB, settings: AppSettings, toolId: string, note: string) {
  const t = await getTool(db, toolId);
  if (t.status === 'Retired' || t.status === 'Under repair') throw new Error(`${t.tag} is ${t.status.toLowerCase()}`);
  if (!note.trim()) throw new Error('Describe the fault');
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { status: 'Under repair', technicianId: undefined, issuedAt: undefined });
    await move(db, settings, toolId, 'Sent for repair', { technicianId: t.technicianId, note });
  });
}

export async function toolRepaired(db: ServiceDB, settings: AppSettings, toolId: string, note?: string) {
  const t = await getTool(db, toolId);
  if (t.status !== 'Under repair') throw new Error(`${t.tag} is not under repair`);
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { status: 'In store' });
    await move(db, settings, toolId, 'Repaired', { note });
  });
}

export async function retireTool(db: ServiceDB, settings: AppSettings, toolId: string, note: string) {
  const t = await getTool(db, toolId);
  if (t.status === 'Retired') return;
  if (!note.trim()) throw new Error('Give a reason for retiring the tool');
  await db.transaction('rw', db.tools, db.toolMoves, async () => {
    await db.tools.update(toolId, { status: 'Retired', technicianId: undefined, issuedAt: undefined });
    await move(db, settings, toolId, 'Retired', { note });
  });
}

/** Charging scales that are overdue for calibration (gas weights from them are unreliable). */
export async function uncalibratedScales(db: ServiceDB, now = runtime.now()) {
  return (await db.tools.where('kind').equals('Charging scale').toArray()).filter((t) => calibrationState(t, now) === 'overdue');
}
