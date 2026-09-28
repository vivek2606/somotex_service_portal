import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteError, SyncEngine, type Remote, type RemoteRow } from '../cloud/sync';
import { runtime, ServiceDB } from '../db/db';
import { hasDemoData, loadDemoData, purgeLocalDemo } from '../db/demo';
import { createComplaint, issueToComplaint, receiveStock, setStatus, updateJobDetails } from '../db/service';
import { DEFAULT_SETTINGS } from '../db/settings';

/** In-memory stand-in for the server, applying the same rules as schema.sql. */
class FakeServer {
  tables = new Map<string, Map<string, { data: Record<string, unknown>; updated_at: string }>>();
  clock = Date.parse('2026-09-28T00:00:00Z');
  seq = 0;
  online = true;

  table(t: string) {
    if (!this.tables.has(t)) this.tables.set(t, new Map());
    return this.tables.get(t)!;
  }
  now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  /** Tables the server doesn't have (schema not updated yet). */
  absent = new Set<string>();

  remote(): Remote {
    return {
      upsert: async (table, rows, appendOnly) => {
        if (!this.online) throw new RemoteError('Failed to fetch', 'network');
        if (this.absent.has(table)) throw new RemoteError(`relation "${table}" does not exist`, 'missing');
        const t = this.table(table);
        const out: RemoteRow[] = [];
        for (const r of rows) {
          const existing = t.get(r.id);
          if (existing && appendOnly) continue;
          let data = { ...r.data };
          if (table === 'movements') {
            let total = 0;
            for (const m of t.values()) if (m.data.itemId === data.itemId) total += m.data.qty as number;
            if ((data.qty as number) < 0 && total + (data.qty as number) < 0) {
              throw new RemoteError(`Not enough stock: ${total} available`, 'rejected');
            }
          }
          if (table === 'complaints') {
            const tmp = String(data.ticketNo ?? '').startsWith('TMP-');
            if (existing && tmp && !String(existing.data.ticketNo).startsWith('TMP-')) data.ticketNo = existing.data.ticketNo;
            else if (!existing && tmp) data.ticketNo = `SMX-2026-${String(++this.seq).padStart(5, '0')}`;
          }
          const row = { data, updated_at: this.now() };
          t.set(r.id, row);
          out.push({ id: r.id, ...row });
        }
        return out;
      },
      pull: async (table, since, limit) => {
        if (!this.online) throw new RemoteError('Failed to fetch', 'network');
        if (this.absent.has(table)) throw new RemoteError(`relation "${table}" does not exist`, 'missing');
        return [...this.table(table).entries()]
          .map(([id, r]) => ({ id, ...r }))
          .filter((r) => !since || r.updated_at >= since)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit);
      },
      subscribe: () => () => {},
    };
  }
}

const settingsA = { ...DEFAULT_SETTINGS, currentUser: 'Exec One', currentUserEmail: 'one@x.com' };
const settingsB = { ...DEFAULT_SETTINGS, currentUser: 'Exec Two', currentUserEmail: 'two@x.com' };
let n = 0;
let server: FakeServer;
let a: ServiceDB;
let b: ServiceDB;
let syncA: SyncEngine;
let syncB: SyncEngine;
const R32 = 'starter-ref-r32';

const newComplaint = () => ({
  customer: { name: 'Cust', phone: '0888 1', address: 'x', type: 'Individual' as const },
  equipment: {
    brand: 'Midea', category: 'Residential AC' as const, model: 'M', serialNo: 'S1',
    capacity: 12000, capacityUnit: 'BTU/h' as const, refrigerant: 'R32' as const, warranty: 'In Warranty' as const,
  },
  complaintType: 'Not cooling', description: '', priority: 'Normal' as const, source: 'Phone' as const,
});

beforeEach(async () => {
  runtime.cloud = true;
  server = new FakeServer();
  a = new ServiceDB(`sync-a-${n}`);
  b = new ServiceDB(`sync-b-${n++}`);
  // The Service Head's device creates the catalogue item.
  await a.items.add({ id: R32, sku: 'REF-R32', name: 'R-32', type: 'Refrigerant', unit: 'kg', refrigerant: 'R32', stock: 0, reorderLevel: 1, unitCost: 0, active: true });
  syncA = new SyncEngine(a, server.remote());
  syncB = new SyncEngine(b, server.remote());
});

afterEach(() => {
  runtime.cloud = false;
});

describe('sync between two devices', () => {
  it('shares complaints and replaces the temporary ticket number', async () => {
    const id = await createComplaint(a, settingsA, newComplaint());
    expect((await a.complaints.get(id))!.ticketNo).toMatch(/^TMP-/);
    await syncA.syncNow();
    expect((await a.complaints.get(id))!.ticketNo).toBe('SMX-2026-00001');
    expect((await a.complaints.get(id))!._dirty).toBe(0);
    await syncB.syncNow();
    const onB = await b.complaints.get(id);
    expect(onB!.ticketNo).toBe('SMX-2026-00001');
    expect(await b.customers.count()).toBe(1);
    expect(await b.logs.where('complaintId').equals(id).count()).toBeGreaterThan(0);
    expect(onB!._dirty).toBe(0);
  });

  it('lets another executive close a complaint and records who did', async () => {
    const id = await createComplaint(a, settingsA, newComplaint());
    await syncA.syncNow();
    await syncB.syncNow();
    await updateJobDetails(b, settingsB, id, { jobType: 'PCB / Electrical Repair', resolution: 'Replaced PCB' });
    await setStatus(b, settingsB, id, 'Closed');
    await syncB.syncNow();
    await syncA.syncNow();
    const onA = await a.complaints.get(id);
    expect(onA!.status).toBe('Closed');
    expect(onA!.closedByEmail).toBe('two@x.com');
    expect(onA!.loggedByEmail).toBe('one@x.com');
  });

  it('derives stock from shared movements and rejects over-issue across devices', async () => {
    await receiveStock(a, settingsA, R32, 5);
    const id = await createComplaint(a, settingsA, newComplaint());
    await syncA.syncNow();
    await syncB.syncNow();
    expect((await b.items.get(R32))!.stock).toBe(5);
    expect((await b.items.get(R32))!._dirty).toBe(0);

    // Both devices issue from the same 5 kg while out of touch.
    await issueToComplaint(a, settingsA, id, R32, 4, 'big job');
    await issueToComplaint(b, settingsB, id, R32, 3, 'big job');
    await syncA.syncNow();
    await syncB.syncNow();

    expect(syncB.state.rejected).toBe(1);
    expect((await b.items.get(R32))!.stock).toBe(1); // 5 − 4; the refused 3 kg doesn't count
    const rejected = await b.movements.where('_dirty').equals(2).first();
    expect(rejected!._syncError).toMatch(/Not enough stock/);

    await syncB.discardRejected('movements', rejected!.id);
    await syncB.syncNow();
    expect(await b.movements.where('_dirty').equals(2).count()).toBe(0);
    expect((await b.items.get(R32))!.stock).toBe(1);
    await syncA.syncNow();
    expect((await a.items.get(R32))!.stock).toBe(1);
  });

  it('keeps unsent local edits when newer server data arrives, then uploads them', async () => {
    const id = await createComplaint(a, settingsA, newComplaint());
    await syncA.syncNow();
    await syncB.syncNow();
    server.online = false;
    await b.complaints.update(id, { description: 'edited on B' });
    await syncB.syncNow();
    expect(syncB.state.status).toBe('offline');
    expect(syncB.state.pending).toBeGreaterThan(0);
    server.online = true;
    await a.complaints.update(id, { preferredVisit: 'Tuesday' });
    await syncA.syncNow();
    await syncB.syncNow();
    expect((await b.complaints.get(id))!.description).toBe('edited on B');
    expect(syncB.state.pending).toBe(0);
    await syncA.syncNow();
    expect((await a.complaints.get(id))!.description).toBe('edited on B');
  });

  it('does not re-upload data it received from the server', async () => {
    await createComplaint(a, settingsA, newComplaint());
    await syncA.syncNow();
    await syncB.syncNow();
    const before = server.clock;
    await syncB.syncNow();
    expect(server.clock).toBe(before);
    expect(syncB.state.pending).toBe(0);
  });
});

describe('upload order', () => {
  it('sends a receipt before the issue that uses it, even when made offline', async () => {
    const id = await createComplaint(a, settingsA, newComplaint());
    // Many receipts and issues made offline; ids are random, so storage order is too.
    for (let i = 0; i < 20; i++) {
      await receiveStock(a, settingsA, R32, 1);
      await issueToComplaint(a, settingsA, id, R32, 1, 'job');
    }
    await syncA.syncNow();
    expect(syncA.state.rejected).toBe(0);
    expect(syncA.state.pending).toBe(0);
    await syncB.syncNow();
    expect((await b.items.get(R32))!.stock).toBe(0);
  });
});

describe('demo data across devices', () => {
  it('uploads demo data and removes it everywhere when the head purges it', async () => {
    await loadDemoData(a, settingsA, 20);
    await syncA.syncNow();
    expect(syncA.state.rejected).toBe(0);
    expect(syncA.state.pending).toBe(0);
    await syncB.syncNow();
    expect(await hasDemoData(b)).toBe(true);
    const real = await createComplaint(b, settingsB, newComplaint());
    await syncB.syncNow();

    // What purge_demo_data() does on the server.
    for (const t of server.tables.values()) for (const id of [...t.keys()]) if (id.startsWith('demo-')) t.delete(id);
    const app = server.table('settings').get('app');
    server.table('settings').set('app', {
      data: { ...(app?.data ?? {}), value: { ...((app?.data.value as object) ?? {}), demoPurgedAt: '2026-09-28T12:00:00Z' } },
      updated_at: server.now(),
    });
    await purgeLocalDemo(a);

    await syncB.syncNow();
    expect(await hasDemoData(b)).toBe(false);
    expect((await b.complaints.toArray()).map((c) => c.id)).toEqual([real]);
    expect((await b.items.get(R32))!.stock).toBe(0);
  });
});

describe('server not yet updated', () => {
  it('keeps syncing other tables and asks for the database update', async () => {
    server.absent.add('cylinders');
    await a.cylinders.add({ id: 'c1', tag: 'R32-01', itemId: R32, measure: 'weight', tareKg: 7, status: 'In store', lastReading: 10, lastReadingAt: '2026-09-28T00:00:00Z', createdAt: '2026-09-28T00:00:00Z' });
    const id = await createComplaint(a, settingsA, newComplaint());
    await syncA.syncNow();
    expect(syncA.state.status).toBe('error');
    expect(syncA.state.message).toMatch(/Database update needed/);
    await syncB.syncNow();
    expect(await b.complaints.get(id)).toBeTruthy(); // complaints still shared
    server.absent.clear();
    await syncA.syncNow();
    expect(syncA.state.status).toBe('idle');
    await syncB.syncNow();
    expect(await b.cylinders.get('c1')).toBeTruthy();
  });
});
