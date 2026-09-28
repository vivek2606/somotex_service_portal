import Dexie, { type EntityTable, type Transaction } from 'dexie';
import type { User } from './auth';
import type {
  BranchRequest,
  Complaint,
  Cylinder,
  CylinderMove,
  ComplaintLog,
  ConsumptionAlert,
  Customer,
  InventoryItem,
  PartReturn,
  Setting,
  StockMovement,
  SyncMeta,
  Technician,
  Tool,
  ToolMove,
} from './types';

type Synced<T> = T & SyncMeta;

/** Tables shared between devices, in the order they are sent (parents first). */
export const SYNCED_TABLES = [
  'settings',
  'technicians',
  'items',
  'customers',
  'complaints',
  'cylinders',
  'requests',
  'tools',
  'partReturns',
  'movements',
  'cylinderMoves',
  'toolMoves',
  'logs',
  'alerts',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** Rows that are never changed after creation. */
export const APPEND_ONLY: SyncedTable[] = ['movements', 'logs', 'toolMoves'];

/** Fields kept only on this device (derived locally). */
export const LOCAL_FIELDS: Partial<Record<SyncedTable, string[]>> = { items: ['stock'] };

export interface Meta {
  key: string;
  value: unknown;
}

export class ServiceDB extends Dexie {
  customers!: EntityTable<Synced<Customer>, 'id'>;
  technicians!: EntityTable<Synced<Technician>, 'id'>;
  complaints!: EntityTable<Synced<Complaint>, 'id'>;
  logs!: EntityTable<Synced<ComplaintLog>, 'id'>;
  items!: EntityTable<Synced<InventoryItem>, 'id'>;
  movements!: EntityTable<Synced<StockMovement>, 'id'>;
  alerts!: EntityTable<Synced<ConsumptionAlert>, 'id'>;
  settings!: EntityTable<Synced<Setting>, 'id'>;
  cylinders!: EntityTable<Synced<Cylinder>, 'id'>;
  cylinderMoves!: EntityTable<Synced<CylinderMove>, 'id'>;
  requests!: EntityTable<Synced<BranchRequest>, 'id'>;
  tools!: EntityTable<Synced<Tool>, 'id'>;
  toolMoves!: EntityTable<Synced<ToolMove>, 'id'>;
  partReturns!: EntityTable<Synced<PartReturn>, 'id'>;
  /** Accounts for local (single-device) mode only. */
  users!: EntityTable<User, 'id'>;
  /** Sync cursors and other device-local state. */
  meta!: EntityTable<Meta, 'key'>;

  constructor(name = 'somotex-service-portal-v2') {
    super(name);
    this.version(1).stores({
      customers: 'id, name, phone, city, createdAt, _dirty',
      technicians: 'id, name, active, _dirty',
      complaints:
        'id, ticketNo, customerId, status, priority, technicianId, createdAt, closedAt, dueAt, equipment.brand, equipment.category, equipment.serialNo, _dirty',
      logs: 'id, complaintId, at, _dirty',
      items: 'id, sku, name, type, refrigerant, _dirty',
      movements: 'id, itemId, kind, at, complaintId, technicianId, _dirty',
      alerts: 'id, complaintId, technicianId, itemId, at, severity, acknowledged, _dirty',
      settings: 'id, _dirty',
      users: 'id, &email',
      meta: '&key',
    });
    this.version(2).stores({
      complaints:
        'id, ticketNo, customerId, status, priority, technicianId, createdAt, closedAt, dueAt, visitDate, branch, equipment.brand, equipment.category, equipment.serialNo, _dirty',
      cylinders: 'id, tag, itemId, status, _dirty',
      cylinderMoves: 'id, cylinderId, itemId, complaintId, outAt, inAt, _dirty',
      requests: 'id, ref, branch, status, complaintId, requestedAt, _dirty',
    });
    this.version(3).stores({
      tools: 'id, tag, kind, branch, status, technicianId, calibrationDue, _dirty',
      toolMoves: 'id, toolId, at, technicianId, _dirty',
      partReturns: 'id, ref, complaintId, stage, branch, brand, createdAt, _dirty',
    });
    markLocalChanges(this);
  }

  /**
   * Runs `fn` in a transaction whose writes come from the server, so they
   * are not marked as local changes to send back.
   */
  applyRemote<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
    return this.transaction('rw', tables, (tx) => {
      (tx as RemoteTx).__remote = true;
      return fn();
    });
  }
}

type RemoteTx = Transaction & { __remote?: boolean };

let lastSeq = 0;
/** Strictly increasing creation order on this device, even within one millisecond. */
function nextSeq() {
  lastSeq = Math.max(Date.now() * 1000, lastSeq + 1);
  return lastSeq;
}

/** Flags every local insert/update on a synced table as pending upload. */
function markLocalChanges(db: ServiceDB) {
  for (const name of SYNCED_TABLES) {
    const local = LOCAL_FIELDS[name] ?? [];
    const table = db.table(name);
    table.hook('creating', (_key, obj, tx) => {
      if ((tx as RemoteTx).__remote) return;
      obj._dirty = 1;
      obj._seq = nextSeq();
    });
    table.hook('updating', (mods, _key, _obj, tx) => {
      if ((tx as RemoteTx).__remote) return undefined;
      const keys = Object.keys(mods);
      // Sync bookkeeping and locally derived fields are not changes to share.
      if (keys.every((k) => k.startsWith('_') || local.includes(k))) return undefined;
      return { _dirty: 1, _syncError: undefined };
    });
  }
}

/** How the app is running, plus hooks used when generating demo data. */
export const runtime = {
  /** Shared through the server (true) or single device. */
  cloud: false,
  /** Clock used for new records; demo data back-dates it. */
  now: () => new Date(),
  /** Prefix for new record ids; demo data uses DEMO_PREFIX so it can be removed later. */
  idPrefix: '',
};

export const DEMO_PREFIX = 'demo-';

export const newId = () => runtime.idPrefix + crypto.randomUUID();

export const db = new ServiceDB();
