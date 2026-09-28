// Gas cylinders weighed out to a job and weighed back in.
//
// Weight-measured cylinders (refrigerants, LPG, MAPP) hold gross − tare kg.
// Pressure-measured cylinders (oxygen, nitrogen) hold roughly
// bar × water capacity (L) / 1000 m³ at room temperature.
//
// Weighing in turns the difference into an Issue to the job, so job
// budgets and alerts use the gas actually consumed. Gas that disappears
// while a cylinder sits in the store is recorded as a Loss.

import { newId, runtime, type ServiceDB } from './db';
import { addLog, getComplaint, recordMovement, reevaluate, round } from './service';
import type { AppSettings } from './settings';
import type { Cylinder, CylinderMeasure, CylinderMove, InventoryItem } from './types';

const nowIso = () => runtime.now().toISOString();

/** Readings within this of each other count as unchanged (scale / gauge accuracy). */
export const TOLERANCE: Record<CylinderMeasure, number> = { weight: 0.05, pressure: 2 };

/** Cylinders out longer than this are flagged as not returned. */
export const OVERDUE_HOURS = 48;

export const readingUnit = (m: CylinderMeasure) => (m === 'weight' ? 'kg' : 'bar');

/** Gas content (in the item's unit) for a reading on this cylinder. */
export function contentAt(c: Pick<Cylinder, 'measure' | 'tareKg' | 'capacityL'>, reading: number): number {
  if (c.measure === 'weight') return round(Math.max(0, reading - (c.tareKg ?? 0)));
  return round(Math.max(0, (reading * (c.capacityL ?? 0)) / 1000));
}

export function measureFor(item: InventoryItem): CylinderMeasure {
  return item.unit.trim().toLowerCase() === 'kg' ? 'weight' : 'pressure';
}

async function getCylinder(db: ServiceDB, id: string) {
  const c = await db.cylinders.get(id);
  if (!c) throw new Error('Cylinder not found');
  return c;
}

export interface NewCylinder {
  tag: string;
  itemId: string;
  tareKg?: number;
  capacityL?: number;
  /** Current gross weight (kg) or pressure (bar). */
  reading: number;
  /** True if its contents are already in the stock figure (e.g. from a stock sheet). */
  alreadyInStock: boolean;
  reference?: string;
}

export async function registerCylinder(db: ServiceDB, settings: AppSettings, input: NewCylinder): Promise<string> {
  const tag = input.tag.trim().toUpperCase();
  if (!tag) throw new Error('Enter the cylinder tag');
  const item = await db.items.get(input.itemId);
  if (!item) throw new Error('Choose the gas');
  const measure = measureFor(item);
  if (measure === 'weight' && !(input.tareKg! >= 0)) throw new Error('Enter the empty (tare) weight stamped on the cylinder');
  if (measure === 'pressure' && !(input.capacityL! > 0)) throw new Error('Enter the cylinder water capacity in litres');
  if (!(input.reading >= 0)) throw new Error('Enter the current reading');
  if (measure === 'weight' && input.reading < input.tareKg!) throw new Error('Gross weight can’t be less than the empty weight');
  const id = newId();
  await db.transaction('rw', [db.cylinders, db.items, db.movements], async () => {
    if ((await db.cylinders.where('tag').equals(tag).filter((c) => c.status !== 'Retired').count()) > 0) {
      throw new Error(`Cylinder ${tag} is already registered`);
    }
    const cyl: Cylinder = {
      id,
      tag,
      itemId: item.id,
      measure,
      tareKg: measure === 'weight' ? input.tareKg : undefined,
      capacityL: measure === 'pressure' ? input.capacityL : undefined,
      status: 'In store',
      lastReading: input.reading,
      lastReadingAt: nowIso(),
      createdAt: nowIso(),
    };
    await db.cylinders.add(cyl);
    const content = contentAt(cyl, input.reading);
    if (!input.alreadyInStock && content > 0) {
      await recordMovement(db, {
        itemId: item.id,
        kind: 'Receipt',
        qty: content,
        reference: input.reference || `Cylinder ${tag}`,
        note: `Cylinder ${tag} registered`,
        by: settings.currentUser,
        byEmail: settings.currentUserEmail,
      });
    }
  });
  return id;
}

export interface WeighOutResult {
  moveId: string;
  /** Gas found missing since the cylinder was last weighed in the store. */
  loss: number;
}

/** A cylinder leaves the store with a technician, usually for a job. */
export async function weighOut(
  db: ServiceDB,
  settings: AppSettings,
  input: { cylinderId: string; reading: number; complaintId?: string; technicianId?: string; note?: string },
): Promise<WeighOutResult> {
  const cyl = await getCylinder(db, input.cylinderId);
  if (cyl.status !== 'In store') throw new Error(`Cylinder ${cyl.tag} is not in the store`);
  if (!(input.reading >= 0)) throw new Error('Enter the reading');
  const tol = TOLERANCE[cyl.measure];
  const unit = readingUnit(cyl.measure);
  if (input.reading > cyl.lastReading + tol) {
    throw new Error(
      `Reading ${input.reading} ${unit} is higher than the last reading (${cyl.lastReading} ${unit}). If it was refilled, record the refill first; otherwise check the scale.`,
    );
  }
  const item = (await db.items.get(cyl.itemId))!;
  const complaint = input.complaintId ? await getComplaint(db, input.complaintId) : undefined;
  const technicianId = input.technicianId ?? complaint?.technicianId;
  const loss = input.reading < cyl.lastReading - tol ? round(contentAt(cyl, cyl.lastReading) - contentAt(cyl, input.reading)) : 0;
  const moveId = newId();

  await db.transaction('rw', [db.cylinders, db.cylinderMoves, db.items, db.movements, db.logs], async () => {
    if (loss > 0) {
      await recordMovement(db, {
        itemId: cyl.itemId,
        kind: 'Loss',
        qty: -loss,
        reference: `Cylinder ${cyl.tag}`,
        note: `Lost in store: ${cyl.lastReading} → ${input.reading} ${unit} since ${cyl.lastReadingAt.slice(0, 10)}`,
        by: settings.currentUser,
        byEmail: settings.currentUserEmail,
      });
    }
    const move: CylinderMove = {
      id: moveId,
      cylinderId: cyl.id,
      itemId: cyl.itemId,
      complaintId: complaint?.id,
      technicianId,
      outAt: nowIso(),
      outReading: input.reading,
      outBy: settings.currentUser,
      note: input.note,
    };
    await db.cylinderMoves.add(move);
    await db.cylinders.update(cyl.id, { status: 'Out', lastReading: input.reading, lastReadingAt: nowIso(), openMoveId: moveId });
    if (complaint) {
      await addLog(
        db,
        complaint.id,
        'material',
        `Cylinder ${cyl.tag} (${item.name}) weighed out at ${input.reading} ${unit}${loss > 0 ? `; ${loss} ${item.unit} found missing in store` : ''}`,
        settings,
      );
    }
  });
  return { moveId, loss };
}

export interface WeighInResult {
  used: number;
  unit: string;
}

/** The cylinder comes back; the difference is booked as gas used on the job. */
export async function weighIn(
  db: ServiceDB,
  settings: AppSettings,
  input: { cylinderId: string; reading: number; note?: string },
): Promise<WeighInResult> {
  const cyl = await getCylinder(db, input.cylinderId);
  if (cyl.status !== 'Out' || !cyl.openMoveId) throw new Error(`Cylinder ${cyl.tag} is not checked out`);
  const move = await db.cylinderMoves.get(cyl.openMoveId);
  if (!move) throw new Error('Checkout record not found');
  if (!(input.reading >= 0)) throw new Error('Enter the reading');
  const tol = TOLERANCE[cyl.measure];
  const unit = readingUnit(cyl.measure);
  if (input.reading > move.outReading + tol) {
    throw new Error(`Reading ${input.reading} ${unit} is higher than when it went out (${move.outReading} ${unit}). Check the scale or gauge.`);
  }
  const item = (await db.items.get(cyl.itemId))!;
  const used = Math.max(0, round(contentAt(cyl, move.outReading) - contentAt(cyl, input.reading)));

  await db.transaction('rw', [db.cylinders, db.cylinderMoves, db.items, db.movements, db.logs], async () => {
    if (used > 0) {
      await recordMovement(db, {
        itemId: cyl.itemId,
        kind: 'Issue',
        qty: -used,
        complaintId: move.complaintId,
        technicianId: move.technicianId,
        cylinderMoveId: move.id,
        reference: `Cylinder ${cyl.tag}`,
        note: `Weighed: ${move.outReading} → ${input.reading} ${unit}${input.note ? ` (${input.note})` : ''}`,
        by: settings.currentUser,
        byEmail: settings.currentUserEmail,
      });
    }
    await db.cylinderMoves.update(move.id, { inAt: nowIso(), inReading: input.reading, inBy: settings.currentUser, used });
    await db.cylinders.update(cyl.id, { status: 'In store', lastReading: input.reading, lastReadingAt: nowIso(), openMoveId: undefined });
    if (move.complaintId) {
      await addLog(
        db,
        move.complaintId,
        'material',
        `Cylinder ${cyl.tag} weighed in at ${input.reading} ${unit}: ${used} ${item.unit} ${item.name} used`,
        settings,
      );
    }
  });
  if (move.complaintId) await reevaluate(db, settings, move.complaintId);
  return { used, unit: item.unit };
}

/** A cylinder refilled or exchanged for a full one of the same tag. */
export async function refillCylinder(db: ServiceDB, settings: AppSettings, cylinderId: string, reading: number, reference?: string) {
  const cyl = await getCylinder(db, cylinderId);
  if (cyl.status !== 'In store') throw new Error('Weigh the cylinder in before recording a refill');
  const added = round(contentAt(cyl, reading) - contentAt(cyl, cyl.lastReading));
  if (added <= 0) throw new Error('The new reading must be higher than the current one');
  await db.transaction('rw', [db.cylinders, db.items, db.movements], async () => {
    await recordMovement(db, {
      itemId: cyl.itemId,
      kind: 'Receipt',
      qty: added,
      reference: reference || `Refill ${cyl.tag}`,
      note: `Cylinder ${cyl.tag} refilled: ${cyl.lastReading} → ${reading} ${readingUnit(cyl.measure)}`,
      by: settings.currentUser,
      byEmail: settings.currentUserEmail,
    });
    await db.cylinders.update(cyl.id, { lastReading: reading, lastReadingAt: nowIso() });
  });
  return added;
}

/** Takes a cylinder out of use (returned to supplier, condemned). Remaining gas is written off. */
export async function retireCylinder(db: ServiceDB, settings: AppSettings, cylinderId: string, note: string) {
  const cyl = await getCylinder(db, cylinderId);
  if (cyl.status === 'Out') throw new Error('Weigh the cylinder in first');
  const left = contentAt(cyl, cyl.lastReading);
  await db.transaction('rw', [db.cylinders, db.items, db.movements], async () => {
    if (left > 0) {
      await recordMovement(db, {
        itemId: cyl.itemId,
        kind: 'Loss',
        qty: -left,
        reference: `Cylinder ${cyl.tag}`,
        note: `Retired with gas left: ${note}`,
        by: settings.currentUser,
        byEmail: settings.currentUserEmail,
      });
    }
    await db.cylinders.update(cyl.id, { status: 'Retired', notes: note });
  });
}
