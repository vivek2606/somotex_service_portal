import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Set these in the hosting provider (or a local .env file) to share data
// between computers. Without them the app runs in single-device mode.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | undefined =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'somotex.auth' },
      })
    : undefined;
