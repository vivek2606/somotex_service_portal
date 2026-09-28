import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { db } from '../db/db';
import { DEFAULT_SETTINGS, loadSettings, type AppSettings } from '../db/settings';

const Ctx = createContext<AppSettings>(DEFAULT_SETTINGS);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const saved = useLiveQuery(() => loadSettings(db), []);
  const { user } = useAuth();
  // Every entry is attributed to the signed-in person.
  const settings = useMemo(
    () => saved && { ...saved, currentUser: user?.displayName ?? '', currentUserEmail: user?.email },
    [saved, user],
  );
  if (!settings) return null;
  return <Ctx.Provider value={settings}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
