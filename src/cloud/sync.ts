// Keeps this device's copy of the data in step with the shared server.
//
// Every screen reads and writes the local database, so the app stays fast
// and keeps working through connection drops. Local changes are flagged
// (_dirty = 1) and uploaded; changes from other devices are fetched by
// server timestamp. A row changed on two devices keeps the last upload.

import { liveQuery, type Subscription } from 'dexie';
import { APPEND_ONLY, LOCAL_FIELDS, SYNCED_TABLES, type ServiceDB, type SyncedTable } from '../db/db';
import { purgeLocalDemo } from '../db/demo';
import { recomputeStock } from '../db/service';

export interface RemoteRow {
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
}

export class RemoteError extends Error {
  /** network: try again later; rejected: the server refused this data; missing: the table isn't on the server yet. */
  constructor(
    message: string,
    readonly kind: 'network' | 'rejected' | 'missing',
  ) {
    super(message);
  }
}

export interface Remote {
  /** Inserts or updates rows; for append-only tables existing rows are left alone. */
  upsert(table: SyncedTable, rows: { id: string; data: Record<string, unknown> }[], appendOnly: boolean): Promise<RemoteRow[]>;
  /** Rows changed at or after `since` (all rows when undefined), oldest first. */
  pull(table: SyncedTable, since: string | undefined, limit: number): Promise<RemoteRow[]>;
  /** Calls back when another device changes a table. Returns an unsubscribe function. */
  subscribe(onChange: (table: string) => void): () => void;
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'offline' | 'error';
  /** Local changes not yet on the server. */
  pending: number;
  /** Local changes the server refused (e.g. stock would go negative). */
  rejected: number;
  lastSyncAt?: string;
  message?: string;
  /** True once this device has fetched everything at least once. */
  initialised: boolean;
}

const PAGE = 1000;
const CHUNK = 200;
/** Re-read a little before the cursor so rows committed out of order aren't missed. */
const OVERLAP_MS = 2 * 60 * 1000;
const POLL_MS = 60 * 1000;

/** Row fields that are sent to the server. */
export function shareable(table: SyncedTable, row: Record<string, unknown>): Record<string, unknown> {
  const local = LOCAL_FIELDS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k.startsWith('_') || local.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function localOnly(table: SyncedTable, row: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LOCAL_FIELDS[table] ?? []) if (row && row[k] !== undefined) out[k] = row[k];
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fields the server sets on complaints that a device must take even while it has local edits. */
const SERVER_OWNED: Partial<Record<SyncedTable, string[]>> = {
  complaints: ['ticketNo', 'loggedBy', 'loggedByEmail', 'closedBy', 'closedByEmail'],
  logs: ['by', 'byEmail'],
  movements: ['by', 'byEmail'],
  toolMoves: ['by', 'byEmail'],
};

export class SyncEngine {
  state: SyncState = { status: 'idle', pending: 0, rejected: 0, initialised: false };
  private listeners = new Set<(s: SyncState) => void>();
  private running = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private subs: Subscription[] = [];
  private unsubscribeRemote?: () => void;
  private readonly onOnline = () => this.schedule(0);
  /** Tables the server doesn't have yet (its schema needs updating). */
  private missing = new Set<SyncedTable>();

  constructor(
    private readonly db: ServiceDB,
    private readonly remote: Remote,
  ) {}

  onChange(fn: (s: SyncState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  async start() {
    this.state.initialised = !!(await this.db.meta.get('initialised'))?.value;
    // Upload soon after any local change.
    this.subs.push(
      liveQuery(() => this.counts()).subscribe((c) => {
        this.set(c);
        if (c.pending > 0) this.schedule(400);
      }),
    );
    this.unsubscribeRemote = this.remote.subscribe(() => this.schedule(300));
    this.poll = setInterval(() => this.schedule(0), POLL_MS);
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    await this.syncNow();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    this.unsubscribeRemote?.();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), delay);
  }

  private async counts() {
    let pending = 0;
    let rejected = 0;
    for (const t of SYNCED_TABLES) {
      pending += await this.db.table(t).where('_dirty').equals(1).count();
      rejected += await this.db.table(t).where('_dirty').equals(2).count();
    }
    return { pending, rejected };
  }

  /** Uploads local changes, then fetches everyone else's. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.set({ status: 'syncing' });
    try {
      this.missing.clear();
      do {
        this.again = false;
        await this.push();
        await this.pull();
      } while (this.again);
      if (this.missing.size) {
        this.set({
          status: 'error',
          message: 'Database update needed: the Service Head should run the latest supabase/schema.sql in Supabase.',
          lastSyncAt: new Date().toISOString(),
          ...(await this.counts()),
        });
        return;
      }
      if (!this.state.initialised) {
        await this.db.meta.put({ key: 'initialised', value: true });
      }
      this.set({ status: 'idle', lastSyncAt: new Date().toISOString(), message: undefined, initialised: true, ...(await this.counts()) });
    } catch (e) {
      const network = e instanceof RemoteError ? e.kind === 'network' : true;
      this.set({ status: network ? 'offline' : 'error', message: (e as Error).message, ...(await this.counts()) });
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ push

  private async push() {
    for (const table of SYNCED_TABLES) {
      if (this.missing.has(table)) continue;
      const rows = (await this.db.table(table).where('_dirty').equals(1).toArray()) as Record<string, unknown>[];
      // Send in the order things were created here: a receipt must reach the
      // server before the issue that draws on it, or the issue is refused.
      const seq = (r: Record<string, unknown>) => (r._seq as number | undefined) ?? 0;
      const when = (r: Record<string, unknown>) => String(r.at ?? r.createdAt ?? '');
      rows.sort((x, y) => seq(x) - seq(y) || when(x).localeCompare(when(y)));
      try {
        for (let i = 0; i < rows.length; i += CHUNK) {
          await this.pushChunk(table, rows.slice(i, i + CHUNK));
        }
      } catch (e) {
        // A table the server doesn't have yet: keep syncing everything else.
        if (e instanceof RemoteError && e.kind === 'missing') this.missing.add(table);
        else throw e;
      }
    }
  }

  private async pushChunk(table: SyncedTable, rows: Record<string, unknown>[]) {
    const payload = rows.map((r) => ({ id: r.id as string, data: shareable(table, r) }));
    let returned: RemoteRow[];
    try {
      returned = await this.remote.upsert(table, payload, APPEND_ONLY.includes(table));
    } catch (e) {
      if (e instanceof RemoteError && e.kind === 'missing') throw e;
      if (!(e instanceof RemoteError) || e.kind !== 'rejected' || payload.length === 1) {
        if (e instanceof RemoteError && e.kind === 'rejected') {
          await this.markRejected(table, payload[0].id, e.message);
          return;
        }
        throw e;
      }
      // One bad row fails the batch: send them singly to find it.
      for (const row of rows) await this.pushChunk(table, [row]);
      return;
    }
    await this.applyPushed(table, payload, returned);
  }

  private async applyPushed(table: SyncedTable, sent: { id: string; data: Record<string, unknown> }[], returned: RemoteRow[]) {
    const byId = new Map(returned.map((r) => [r.id, r]));
    const owned = SERVER_OWNED[table] ?? [];
    await this.db.applyRemote([table], async () => {
      const t = this.db.table(table);
      for (const s of sent) {
        const current = (await t.get(s.id)) as Record<string, unknown> | undefined;
        if (!current) continue;
        const server = byId.get(s.id);
        if (same(shareable(table, current), s.data)) {
          // Nothing changed locally while uploading: take the server's version.
          await t.put({
            ...(server ? server.data : s.data),
            id: s.id,
            ...localOnly(table, current),
            _dirty: 0,
            _serverAt: server?.updated_at ?? current._serverAt,
          });
        } else if (server && owned.length) {
          // Edited again meanwhile: keep the edit pending, but take server-owned fields.
          const patch: Record<string, unknown> = {};
          for (const k of owned) patch[k] = server.data[k];
          await t.update(s.id, patch);
        }
      }
    });
  }

  private async markRejected(table: SyncedTable, id: string, message: string) {
    await this.db.applyRemote([table, 'items', 'movements'], async () => {
      await this.db.table(table).update(id, { _dirty: 2, _syncError: message });
      if (table === 'movements') {
        const m = await this.db.movements.get(id);
        if (m) await recomputeStock(this.db, [m.itemId]);
      }
    });
  }

  /** Drops a change the server refused; it only ever existed on this device. */
  async discardRejected(table: SyncedTable, id: string) {
    await this.db.applyRemote([table, 'items', 'movements'], async () => {
      const row = (await this.db.table(table).get(id)) as Record<string, unknown> | undefined;
      if (!row || row._dirty !== 2) return;
      if (row._serverAt) {
        // It exists on the server: fetch that version again on the next pull.
        await this.db.table(table).update(id, { _dirty: 0, _serverAt: '', _syncError: undefined });
        await this.db.meta.delete(`pull:${table}`);
      } else {
        await this.db.table(table).delete(id);
      }
      if (table === 'movements') await recomputeStock(this.db, [row.itemId as string]);
    });
    this.schedule(0);
  }

  // ------------------------------------------------------------------ pull

  private async pull() {
    for (const table of SYNCED_TABLES) {
      if (this.missing.has(table)) continue;
      const key = `pull:${table}`;
      const cursor = (await this.db.meta.get(key))?.value as string | undefined;
      let since = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString() : undefined;
      let newest = cursor;
      for (;;) {
        let rows: RemoteRow[];
        try {
          rows = await this.remote.pull(table, since, PAGE);
        } catch (e) {
          if (e instanceof RemoteError && e.kind === 'missing') {
            this.missing.add(table);
            break;
          }
          throw e;
        }
        if (rows.length) {
          await this.applyPulled(table, rows);
          const last = rows[rows.length - 1].updated_at;
          if (!newest || last > newest) newest = last;
        }
        if (rows.length < PAGE) break;
        const next = rows[rows.length - 1].updated_at;
        if (next === since) break;
        since = next;
      }
      if (newest && newest !== cursor) await this.db.meta.put({ key, value: newest });
    }
  }

  private async applyPulled(table: SyncedTable, rows: RemoteRow[]) {
    const touchedItems = new Set<string>();
    const owned = SERVER_OWNED[table] ?? [];
    await this.db.applyRemote([table, 'items', 'movements'], async () => {
      const t = this.db.table(table);
      for (const r of rows) {
        const current = (await t.get(r.id)) as Record<string, unknown> | undefined;
        if (current?._serverAt && (current._serverAt as string) >= r.updated_at) continue;
        if (current?._dirty === 1 || current?._dirty === 2) {
          // Local edits win until uploaded, but server-owned fields are taken now.
          if (owned.length) {
            const patch: Record<string, unknown> = {};
            for (const k of owned) patch[k] = r.data[k];
            await t.update(r.id, patch);
          }
          continue;
        }
        await t.put({ ...r.data, id: r.id, ...localOnly(table, current), _dirty: 0, _serverAt: r.updated_at });
        if (table === 'movements') touchedItems.add(r.data.itemId as string);
        if (table === 'items' && current?.stock === undefined) touchedItems.add(r.id);
      }
      if (touchedItems.size) await recomputeStock(this.db, touchedItems);
    });
    if (table === 'settings') await this.followDemoPurge();
  }

  /** When the Service Head removes demo data, drop this device's copy too. */
  private async followDemoPurge() {
    const value = (await this.db.settings.get('app'))?.value as { demoPurgedAt?: string } | undefined;
    const purgedAt = value?.demoPurgedAt;
    if (!purgedAt) return;
    const seen = (await this.db.meta.get('demoPurgedAt'))?.value;
    if (seen === purgedAt) return;
    await purgeLocalDemo(this.db);
    await this.db.meta.put({ key: 'demoPurgedAt', value: purgedAt });
  }
}
