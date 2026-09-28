import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncedTable } from '../db/db';
import { RemoteError, type Remote, type RemoteRow } from './sync';

interface PgError {
  message: string;
  code?: string;
}

/** Errors with a database error code are refusals; anything else is treated as connectivity. */
function toRemoteError(e: PgError): RemoteError {
  const code = e.code ?? '';
  const refused = /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && code !== '57014';
  const message = code === '42501' ? 'Not allowed for your role' : e.message;
  return new RemoteError(message, refused ? 'rejected' : 'network');
}

export function supabaseRemote(sb: SupabaseClient): Remote {
  return {
    async upsert(table, rows, appendOnly) {
      const { data, error } = await sb
        .from(table)
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: appendOnly })
        .select('id, data, updated_at');
      if (error) throw toRemoteError(error);
      return (data ?? []) as RemoteRow[];
    },
    async pull(table, since, limit) {
      let q = sb.from(table).select('id, data, updated_at').order('updated_at', { ascending: true }).limit(limit);
      if (since) q = q.gte('updated_at', since);
      const { data, error } = await q;
      if (error) throw toRemoteError(error);
      return (data ?? []) as RemoteRow[];
    },
    subscribe(onChange) {
      const channel = sb
        .channel('app-changes')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => onChange(payload.table as SyncedTable))
        .subscribe();
      return () => {
        void sb.removeChannel(channel);
      };
    },
  };
}
