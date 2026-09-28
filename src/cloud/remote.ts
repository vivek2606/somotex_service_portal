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
  if (code === '42P01' || code === 'PGRST205' || /could not find the table|does not exist/i.test(e.message)) {
    return new RemoteError(e.message, 'missing');
  }
  const refused = /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && code !== '57014';
  const message = code === '42501' ? 'Not allowed for your role' : e.message;
  return new RemoteError(message, refused ? 'rejected' : 'network');
}

/** Server table names that differ from the device's. */
const SERVER_NAME: Partial<Record<SyncedTable, string>> = {
  cylinderMoves: 'cylinder_moves',
  toolMoves: 'tool_moves',
  partReturns: 'part_returns',
};
const serverName = (t: SyncedTable) => SERVER_NAME[t] ?? t;

export function supabaseRemote(sb: SupabaseClient): Remote {
  return {
    async upsert(table, rows, appendOnly) {
      const { data, error } = await sb
        .from(serverName(table))
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: appendOnly })
        .select('id, data, updated_at');
      if (error) throw toRemoteError(error);
      return (data ?? []) as RemoteRow[];
    },
    async pull(table, since, limit) {
      let q = sb.from(serverName(table)).select('id, data, updated_at').order('updated_at', { ascending: true }).limit(limit);
      if (since) q = q.gte('updated_at', since);
      const { data, error } = await q;
      if (error) throw toRemoteError(error);
      return (data ?? []) as RemoteRow[];
    },
    subscribe(onChange) {
      const channel = sb
        .channel('app-changes')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => onChange(payload.table))
        .subscribe();
      return () => {
        void sb.removeChannel(channel);
      };
    },
  };
}
