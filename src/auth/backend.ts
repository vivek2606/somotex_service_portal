// One interface for signing in and managing staff accounts, with two
// implementations: accounts on this device only, or shared through Supabase.

import type { SupabaseClient } from '@supabase/supabase-js';
import * as local from '../db/auth';
import type { NewUser, Role, SessionUser } from '../db/auth';
import type { ServiceDB } from '../db/db';

export interface StaffAccount {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
}

export interface SetupInput {
  email: string;
  displayName: string;
  password: string;
}

export interface AuthBackend {
  mode: 'local' | 'cloud';
  /** True until the first Service Head account exists. */
  needsSetup(): Promise<boolean>;
  setup(input: SetupInput): Promise<SessionUser>;
  login(email: string, password: string): Promise<SessionUser>;
  restore(): Promise<SessionUser | undefined>;
  logout(): Promise<void>;
  changePassword(user: SessionUser, current: string, next: string): Promise<void>;
  listStaff(): Promise<StaffAccount[]>;
  createStaff(actor: SessionUser, input: NewUser): Promise<void>;
  resetPassword(actor: SessionUser, userId: string, temporary: string): Promise<void>;
  updateStaff(actor: SessionUser, account: StaffAccount, patch: Partial<Pick<StaffAccount, 'displayName' | 'role' | 'active'>>): Promise<void>;
  /** Records activity so idle sessions can expire. */
  touch(): void;
}

// ------------------------------------------------------------ this device

export function localBackend(db: ServiceDB): AuthBackend {
  return {
    mode: 'local',
    needsSetup: async () => !(await local.hasUsers(db)),
    async setup(input) {
      await local.setupFirstHead(db, input);
      return this.login(input.email, input.password);
    },
    async login(email, password) {
      const user = await local.login(db, email, password);
      local.saveSession(user.id);
      return user;
    },
    restore: () => local.restoreSession(db),
    async logout() {
      local.clearSession();
    },
    changePassword: (user, current, next) => local.changePassword(db, user.id, current, next),
    async listStaff() {
      const users = await db.users.orderBy('email').toArray();
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        active: u.active,
        mustChangePassword: u.mustChangePassword,
        lastLoginAt: u.lastLoginAt,
      }));
    },
    async createStaff(actor, input) {
      if (!local.can(actor, 'manageUsers')) throw new Error('Only the Service Head can create accounts');
      await local.createUser(db, { ...input, mustChangePassword: true });
    },
    resetPassword: (actor, userId, temporary) => local.resetPassword(db, actor, userId, temporary),
    updateStaff: (actor, account, patch) => local.updateUser(db, actor, account.id, patch),
    touch: local.touchSession,
  };
}

// ------------------------------------------------------------ shared server

const PROFILE_CACHE = 'somotex.profile';

interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  active: boolean;
  must_change_password: boolean;
}

const toSession = (p: ProfileRow): SessionUser => ({
  id: p.id,
  email: p.email,
  displayName: p.display_name,
  role: p.role,
  mustChangePassword: p.must_change_password,
});

function cacheProfile(p: SessionUser | undefined) {
  try {
    if (p) localStorage.setItem(PROFILE_CACHE, JSON.stringify(p));
    else localStorage.removeItem(PROFILE_CACHE);
  } catch {
    /* storage unavailable */
  }
}

function cachedProfile(userId: string): SessionUser | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_CACHE) ?? 'null') as SessionUser | null;
    return p?.id === userId ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Turns server errors into messages the helpdesk can act on. */
function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password';
  if (/banned/i.test(message)) return 'This account has been disabled. Contact the Service Head.';
  if (/failed to fetch|network|load failed/i.test(message)) return 'Can’t reach the server. Check the internet connection.';
  return message;
}

export function cloudBackend(sb: SupabaseClient): AuthBackend {
  async function loadProfile(userId: string): Promise<SessionUser> {
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle<ProfileRow>();
    if (error) throw new Error(friendly(error.message));
    if (!data) throw new Error('No staff profile exists for this account. Ask the Service Head to create one.');
    if (!data.active) throw new Error('This account has been disabled. Contact the Service Head.');
    const user = toSession(data);
    cacheProfile(user);
    return user;
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(friendly(error.message));
    return data as unknown;
  }

  return {
    mode: 'cloud',
    async needsSetup() {
      return (await rpc('staff_count', {})) === 0;
    },
    async setup(input) {
      await rpc('create_staff_user', {
        p_email: input.email,
        p_display_name: input.displayName,
        p_role: 'head',
        p_password: input.password,
      });
      return this.login(input.email, input.password);
    },
    async login(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email: local.normalizeEmail(email), password });
      if (error) throw new Error(friendly(error.message));
      try {
        return await loadProfile(data.user.id);
      } catch (e) {
        await sb.auth.signOut();
        throw e;
      }
    },
    async restore() {
      const { data } = await sb.auth.getSession();
      const session = data.session;
      if (!session) return undefined;
      try {
        return await loadProfile(session.user.id);
      } catch (e) {
        // Offline: carry on with the profile from the last successful sign-in.
        const cached = cachedProfile(session.user.id);
        if (cached && /reach the server/.test((e as Error).message)) return cached;
        await sb.auth.signOut();
        cacheProfile(undefined);
        return undefined;
      }
    },
    async logout() {
      cacheProfile(undefined);
      await sb.auth.signOut();
    },
    async changePassword(user, current, next) {
      const err = local.validatePassword(next);
      if (err) throw new Error(err);
      if (current === next) throw new Error('Choose a password different from the current one');
      const check = await sb.auth.signInWithPassword({ email: user.email, password: current });
      if (check.error) throw new Error('Current password is incorrect');
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) throw new Error(friendly(error.message));
      await rpc('password_changed', {});
      cacheProfile({ ...user, mustChangePassword: false });
    },
    async listStaff() {
      const { data, error } = await sb.from('profiles').select('*').order('display_name');
      if (error) throw new Error(friendly(error.message));
      return (data as ProfileRow[]).map((p) => ({
        id: p.id,
        email: p.email,
        displayName: p.display_name,
        role: p.role,
        active: p.active,
        mustChangePassword: p.must_change_password,
      }));
    },
    async createStaff(_actor, input) {
      await rpc('create_staff_user', {
        p_email: input.email,
        p_display_name: input.displayName,
        p_role: input.role,
        p_password: input.password,
      });
    },
    async resetPassword(_actor, userId, temporary) {
      await rpc('reset_staff_password', { p_user_id: userId, p_password: temporary });
    },
    async updateStaff(_actor, account, patch) {
      await rpc('update_staff', {
        p_user_id: account.id,
        p_display_name: patch.displayName ?? account.displayName,
        p_role: patch.role ?? account.role,
        p_active: patch.active ?? account.active,
      });
    },
    touch() {
      /* Supabase manages its own session lifetime. */
    },
  };
}
