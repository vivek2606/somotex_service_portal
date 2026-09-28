import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { localBackend } from '../auth/backend';
import { can } from '../db/auth';
import { ServiceDB } from '../db/db';

let db: ServiceDB;
let n = 0;
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

beforeEach(() => {
  db = new ServiceDB(`auth-${n++}`);
  store.clear();
});

describe('local accounts', () => {
  it('runs first-time setup once, creating the Service Head', async () => {
    const auth = localBackend(db);
    expect(await auth.needsSetup()).toBe(true);
    const head = await auth.setup({ email: 'Head@Somotex.com', displayName: 'Head', password: 'secret123' });
    expect(head).toMatchObject({ email: 'head@somotex.com', role: 'head', mustChangePassword: false });
    expect(await auth.needsSetup()).toBe(false);
    await expect(auth.setup({ email: 'x@y.com', displayName: 'X', password: 'secret123' })).rejects.toThrow(/already/);
    expect(await auth.restore()).toMatchObject({ email: 'head@somotex.com' });
  });

  it('lets the head add executives who must change their password', async () => {
    const auth = localBackend(db);
    const head = await auth.setup({ email: 'head@s.com', displayName: 'Head', password: 'secret123' });
    await auth.createStaff(head, { email: 'exec1@s.com', displayName: 'Exec One', role: 'executive', password: 'Temp12345' });
    const exec = await auth.login('exec1@s.com', 'Temp12345');
    expect(exec.mustChangePassword).toBe(true);
    await expect(auth.createStaff(exec, { email: 'e2@s.com', displayName: 'E', role: 'executive', password: 'Temp12345' })).rejects.toThrow(/Service Head/);
    await auth.changePassword(exec, 'Temp12345', 'MyOwnPass9');
    expect((await auth.login('exec1@s.com', 'MyOwnPass9')).mustChangePassword).toBe(false);
    await expect(auth.login('exec1@s.com', 'Temp12345')).rejects.toThrow(/Incorrect email or password/);
  });

  it('rejects weak passwords and wrong current passwords', async () => {
    const auth = localBackend(db);
    const head = await auth.setup({ email: 'head@s.com', displayName: 'Head', password: 'secret123' });
    await expect(auth.createStaff(head, { email: 'e@s.com', displayName: 'E', role: 'executive', password: 'short' })).rejects.toThrow(/8 characters/);
    await expect(auth.changePassword(head, 'wrongpass1', 'newpass123')).rejects.toThrow(/Current password/);
  });

  it('locks an account after repeated failures', async () => {
    const auth = localBackend(db);
    await auth.setup({ email: 'head@s.com', displayName: 'Head', password: 'secret123' });
    for (let i = 0; i < 5; i++) await expect(auth.login('head@s.com', 'nope12345')).rejects.toThrow(/Incorrect/);
    await expect(auth.login('head@s.com', 'secret123')).rejects.toThrow(/Too many failed attempts/);
  });

  it('keeps at least one active Service Head and blocks disabled accounts', async () => {
    const auth = localBackend(db);
    const head = await auth.setup({ email: 'head@s.com', displayName: 'Head', password: 'secret123' });
    await auth.createStaff(head, { email: 'e@s.com', displayName: 'E', role: 'executive', password: 'Temp12345' });
    const [headAcc, execAcc] = (await auth.listStaff()).sort((a) => (a.role === 'head' ? -1 : 1));
    await expect(auth.updateStaff(head, headAcc, { role: 'executive' })).rejects.toThrow(/at least one active Service Head/);
    await auth.updateStaff(head, execAcc, { active: false });
    await expect(auth.login('e@s.com', 'Temp12345')).rejects.toThrow(/disabled/);
  });

  it('gives executives the helpdesk but not the controls', () => {
    const exec = { role: 'executive' as const };
    expect(can(exec, 'manageUsers')).toBe(false);
    expect(can(exec, 'reviewAlerts')).toBe(false);
    expect(can(exec, 'reopenOrCancel')).toBe(false);
    expect(can({ role: 'head' }, 'manageUsers')).toBe(true);
  });
});
