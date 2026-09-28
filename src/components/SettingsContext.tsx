import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, type ReactNode } from 'react';
import { db } from '../db/db';
import { DEFAULT_SETTINGS, loadSettings, type AppSettings } from '../db/settings';

const Ctx = createContext<AppSettings>(DEFAULT_SETTINGS);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useLiveQuery(() => loadSettings(db), []);
  if (!settings) return null;
  return <Ctx.Provider value={settings}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
