// User accounts, password hashing and role permissions.
//
// Passwords are never stored: only a salted PBKDF2-SHA256 hash. Accounts are
// kept in the same database as the rest of the data (and so are included in
// backups).

import { newId, type ServiceDB } from './db';

export type Role = 'head' | 'executive';

export const ROLE_LABEL: Record<Role, string> = {
  head: 'Service Head',
  executive: 'Helpdesk Executive',
};

export interface User {
  id: string;
  /** Login email, stored lower-case. */
  email: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  salt: string;
  active: boolean;
  /** Set when the Service Head creates or resets the account. */
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil?: string;
  createdAt: string;
  lastLoginAt?: string;
}

/** What the rest of the app sees about the signed-in user. */
export type SessionUser = Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'mustChangePassword'>;

export type Permission =
  | 'manageUsers'
  | 'editSettings'
  | 'manageTechnicians'
  | 'editItems'
  | 'importStock'
  | 'adjustStock'
  | 'reviewAlerts'
  | 'reopenOrCancel'
  | 'backupRestore';

/** Executives run the helpdesk; everything that changes controls is for the Service Head. */
const HEAD_ONLY: Permission[] = [
  'manageUsers',
  'editSettings',
  'manageTechnicians',
  'editItems',
  'importStock',
  'adjustStock',
  'reviewAlerts',
  'reopenOrCancel',
  'backupRestore',
];

export function can(user: Pick<User, 'role'> | undefined, p: Permission): boolean {
  if (!user) return false;
  if (user.role === 'head') return true;
  return !HEAD_ONLY.includes(p);
}

const ITERATIONS = 150_000;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 10;

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

export async function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validatePassword(pw: string): string | undefined {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return undefined;
}

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

function validateEmail(e: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'Enter a valid email address';
  return undefined;
}

export function toSession(u: User): SessionUser {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, mustChangePassword: u.mustChangePassword };
}

export async function hasUsers(db: ServiceDB) {
  return (await db.users.count()) > 0;
}

export interface NewUser {
  email: string;
  displayName: string;
  role: Role;
  password: string;
  /** Force a password change at first login (for accounts made by the Service Head). */
  mustChangePassword?: boolean;
}

export async function createUser(db: ServiceDB, input: NewUser): Promise<string> {
  const email = normalizeEmail(input.email);
  const err = validateEmail(email) ?? validatePassword(input.password);
  if (err) throw new Error(err);
  if (!input.displayName.trim()) throw new Error('Enter the person’s name');
  const { hash, salt } = await hashPassword(input.password);
  return db.transaction('rw', db.users, async () => {
    if (await db.users.where('email').equals(email).count()) throw new Error(`An account for ${email} already exists`);
    const id = newId();
    await db.users.add({
      id,
      email,
      displayName: input.displayName.trim(),
      role: input.role,
      passwordHash: hash,
      salt,
      active: true,
      mustChangePassword: !!input.mustChangePassword,
      failedAttempts: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  });
}

/** Creates the first Service Head account. Only allowed while there are no users. */
export async function setupFirstHead(db: ServiceDB, input: Omit<NewUser, 'role' | 'mustChangePassword'>) {
  if (await hasUsers(db)) throw new Error('Setup has already been completed');
  return createUser(db, { ...input, role: 'head' });
}

const GENERIC_LOGIN_ERROR = 'Incorrect email or password';

export async function login(db: ServiceDB, emailInput: string, password: string): Promise<SessionUser> {
  const email = normalizeEmail(emailInput);
  const user = await db.users.where('email').equals(email).first();
  if (!user) {
    // Spend the same time as a real check so accounts can't be probed by timing.
    await hashPassword(password);
    throw new Error(GENERIC_LOGIN_ERROR);
  }
  const now = new Date();
  if (user.lockedUntil && new Date(user.lockedUntil) > now) {
    const mins = Math.ceil((new Date(user.lockedUntil).getTime() - now.getTime()) / 60000);
    throw new Error(`Too many failed attempts. Try again in ${mins} min, or ask the Service Head to reset your password.`);
  }
  const { hash } = await hashPassword(password, user.salt);
  if (!sameHash(hash, user.passwordHash)) {
    const failed = user.failedAttempts + 1;
    await db.users.update(user.id!, {
      failedAttempts: failed >= MAX_ATTEMPTS ? 0 : failed,
      lockedUntil: failed >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString() : undefined,
    });
    throw new Error(GENERIC_LOGIN_ERROR);
  }
  if (!user.active) throw new Error('This account has been disabled. Contact the Service Head.');
  await db.users.update(user.id!, { failedAttempts: 0, lockedUntil: undefined, lastLoginAt: now.toISOString() });
  return toSession({ ...user, lastLoginAt: now.toISOString() });
}

export async function changePassword(db: ServiceDB, userId: string, current: string, next: string) {
  const user = await db.users.get(userId);
  if (!user) throw new Error('User not found');
  const { hash } = await hashPassword(current, user.salt);
  if (!sameHash(hash, user.passwordHash)) throw new Error('Current password is incorrect');
  const err = validatePassword(next);
  if (err) throw new Error(err);
  if (current === next) throw new Error('Choose a password different from the current one');
  const fresh = await hashPassword(next);
  await db.users.update(userId, { passwordHash: fresh.hash, salt: fresh.salt, mustChangePassword: false });
}

/** Service Head sets a temporary password; the user must change it at next login. */
export async function resetPassword(db: ServiceDB, actor: SessionUser, userId: string, temporary: string) {
  if (!can(actor, 'manageUsers')) throw new Error('Only the Service Head can reset passwords');
  const err = validatePassword(temporary);
  if (err) throw new Error(err);
  const fresh = await hashPassword(temporary);
  await db.users.update(userId, {
    passwordHash: fresh.hash,
    salt: fresh.salt,
    mustChangePassword: userId !== actor.id,
    failedAttempts: 0,
    lockedUntil: undefined,
  });
}

export async function updateUser(
  db: ServiceDB,
  actor: SessionUser,
  userId: string,
  patch: Partial<Pick<User, 'displayName' | 'role' | 'active'>>,
) {
  if (!can(actor, 'manageUsers')) throw new Error('Only the Service Head can change accounts');
  await db.transaction('rw', db.users, async () => {
    const user = await db.users.get(userId);
    if (!user) throw new Error('User not found');
    const losesHead = user.role === 'head' && user.active && (patch.role === 'executive' || patch.active === false);
    if (losesHead) {
      const heads = await db.users.filter((u) => u.role === 'head' && u.active).count();
      if (heads <= 1) throw new Error('There must always be at least one active Service Head');
    }
    await db.users.update(userId, patch);
  });
}

// ------------------------------------------------------------- session

const SESSION_KEY = 'somotex.session';
/** Sessions end after this much inactivity. */
const IDLE_HOURS = 10;

interface StoredSession {
  userId: string;
  lastActive: number;
}

export function saveSession(userId: string) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, lastActive: Date.now() } satisfies StoredSession));
  } catch {
    /* storage unavailable: session lasts for this page only */
  }
}

export function touchSession() {
  const s = readSession();
  if (s) saveSession(s.userId);
}

export function readSession(): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as StoredSession;
    if (Date.now() - s.lastActive > IDLE_HOURS * 3600000) {
      localStorage.removeItem(SESSION_KEY);
      return undefined;
    }
    return s;
  } catch {
    return undefined;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Restores the signed-in user from the stored session, if still valid. */
export async function restoreSession(db: ServiceDB): Promise<SessionUser | undefined> {
  const s = readSession();
  if (!s) return undefined;
  const user = await db.users.get(s.userId);
  if (!user || !user.active) {
    clearSession();
    return undefined;
  }
  return toSession(user);
}
