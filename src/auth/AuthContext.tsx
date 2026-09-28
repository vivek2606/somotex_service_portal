import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabaseRemote } from '../cloud/remote';
import { supabase } from '../cloud/supabase';
import { SyncEngine, type SyncState } from '../cloud/sync';
import { can, type Permission, type SessionUser } from '../db/auth';
import { db } from '../db/db';
import { seedIfEmpty } from '../db/seed';
import { cloudBackend, localBackend, type AuthBackend } from './backend';

export const backend: AuthBackend = supabase ? cloudBackend(supabase) : localBackend(db);

interface AuthValue {
  user?: SessionUser;
  backend: AuthBackend;
  sync?: SyncEngine;
  setUser: (u: SessionUser | undefined) => void;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ user, setUser, children }: { user?: SessionUser; setUser: (u?: SessionUser) => void; children: ReactNode }) {
  const [sync, setSync] = useState<SyncEngine>();

  // Start syncing once someone is signed in (shared mode only).
  useEffect(() => {
    if (!supabase || !user || user.mustChangePassword) return;
    const engine = new SyncEngine(db, supabaseRemote(supabase));
    setSync(engine);
    let stopped = false;
    void engine.start().then(async () => {
      // A new organisation starts with the standard catalogue, created once by the Service Head.
      if (!stopped && engine.state.initialised && user.role === 'head') await seedIfEmpty(db);
    });
    return () => {
      stopped = true;
      engine.stop();
      setSync(undefined);
    };
  }, [user]);

  // Keep the session alive while the app is being used.
  useEffect(() => {
    if (!user) return;
    const touch = () => backend.touch();
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
    };
  }, [user]);

  const logout = useCallback(async () => {
    await backend.logout();
    // The next person starts from the dashboard, not the previous user's page.
    window.location.hash = '#/';
    setUser(undefined);
  }, [setUser]);

  const value = useMemo<AuthValue>(
    () => ({ user, backend, sync, setUser, logout, can: (p) => can(user, p) }),
    [user, sync, setUser, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

/** The signed-in user; only use below the login gate. */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('Not signed in');
  return user;
}

export function useSyncState(): SyncState | undefined {
  const { sync } = useAuth();
  const [state, setState] = useState<SyncState | undefined>(sync?.state);
  useEffect(() => {
    if (!sync) {
      setState(undefined);
      return;
    }
    return sync.onChange((s) => setState(s));
  }, [sync]);
  return state;
}
