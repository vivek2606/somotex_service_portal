// Defective parts on their way back from the customer's site to the Lagos
// store, and on to the principal brand for a warranty claim.

import { newId, runtime, type ServiceDB } from './db';
import { addLog, getComplaint } from './service';
import type { AppSettings } from './settings';
import { RETURN_STAGES, type PartReturn, type ReturnStage } from './types';

const nowIso = () => runtime.now().toISOString();

/** Parts not received in Lagos within this many days are flagged. */
export const RETURN_DUE_DAYS = 14;

/** Stages after which the part has reached Lagos. */
const FINAL: ReturnStage[] = ['Received in Lagos', 'Sent to principal', 'Scrapped'];

export const isReturnClosed = (r: Pick<PartReturn, 'stage'>) => r.stage === 'Sent to principal' || r.stage === 'Scrapped';
export const hasReachedLagos = (r: Pick<PartReturn, 'stage'>) => FINAL.includes(r.stage);

export function isReturnLate(r: Pick<PartReturn, 'stage' | 'createdAt'>, now = runtime.now()) {
  return !hasReachedLagos(r) && now.getTime() - Date.parse(r.createdAt) > RETURN_DUE_DAYS * 86400000;
}

/** The next stages a return can move to from its current one. */
export function nextStages(stage: ReturnStage): ReturnStage[] {
  switch (stage) {
    case 'At site':
      return ['With technician', 'At branch', 'In transit to Lagos', 'Received in Lagos'];
    case 'With technician':
      return ['At branch', 'In transit to Lagos', 'Received in Lagos'];
    case 'At branch':
      return ['In transit to Lagos', 'Received in Lagos'];
    case 'In transit to Lagos':
      return ['Received in Lagos'];
    case 'Received in Lagos':
      return ['Sent to principal', 'Scrapped'];
    default:
      return [];
  }
}

export interface NewReturn {
  complaintId: string;
  itemId?: string;
  partName: string;
  partSerial?: string;
  stage?: ReturnStage;
  note?: string;
}

export async function createReturn(db: ServiceDB, settings: AppSettings, input: NewReturn): Promise<string> {
  const c = await getComplaint(db, input.complaintId);
  let partName = input.partName.trim();
  if (!partName && input.itemId) partName = (await db.items.get(input.itemId))?.name ?? '';
  if (!partName) throw new Error('Enter the defective part');
  const stage = input.stage ?? 'At site';
  const at = nowIso();
  const id = newId();
  const ref = `RTN-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  await db.transaction('rw', db.partReturns, db.logs, async () => {
    await db.partReturns.add({
      id,
      ref,
      complaintId: c.id,
      itemId: input.itemId || undefined,
      partName,
      partSerial: input.partSerial?.trim() || undefined,
      brand: c.equipment.brand,
      branch: c.branch,
      stage,
      history: [{ stage, at, by: settings.currentUser, note: input.note?.trim() || undefined }],
      createdAt: at,
      updatedAt: at,
    });
    await addLog(db, c.id, 'material', `Defective ${partName} to be returned to Lagos (${ref})`, settings);
  });
  return id;
}

export async function advanceReturn(
  db: ServiceDB,
  settings: AppSettings,
  id: string,
  stage: ReturnStage,
  details: { note?: string; waybill?: string; carrier?: string; claimRef?: string } = {},
) {
  const r = await db.partReturns.get(id);
  if (!r) throw new Error('Return not found');
  if (!nextStages(r.stage).includes(stage)) throw new Error(`Can’t move from “${r.stage}” to “${stage}”`);
  if (stage === 'Sent to principal' && !details.claimRef?.trim()) throw new Error('Enter the principal’s claim or RMA number');
  if (stage === 'Scrapped' && !details.note?.trim()) throw new Error('Give a reason for scrapping the part');
  const at = nowIso();
  const patch: Partial<PartReturn> = {
    stage,
    updatedAt: at,
    history: [...r.history, { stage, at, by: settings.currentUser, note: details.note?.trim() || undefined }],
  };
  if (details.waybill?.trim()) patch.waybill = details.waybill.trim();
  if (details.carrier?.trim()) patch.carrier = details.carrier.trim();
  if (details.claimRef?.trim()) patch.claimRef = details.claimRef.trim();
  await db.transaction('rw', db.partReturns, db.logs, async () => {
    await db.partReturns.update(id, patch);
    const extra = [details.waybill && `waybill ${details.waybill}`, details.claimRef && `claim ${details.claimRef}`, details.note]
      .filter(Boolean)
      .join(', ');
    await addLog(db, r.complaintId, 'material', `${r.ref} ${r.partName}: ${stage}${extra ? ` (${extra})` : ''}`, settings);
  });
}

/** Stage index, for sorting. */
export const stageOrder = (s: ReturnStage) => RETURN_STAGES.indexOf(s);
