-- Somotex Service Portal: shared database for Supabase.
--
-- Run this once in the Supabase dashboard (SQL Editor → New query → paste → Run).
-- It is safe to run again after updates: it only creates what is missing and
-- replaces functions and policies.
--
-- Data model: each app table stores one JSON document per row, keyed by the
-- id the app generates. The server stamps updated_at so devices can fetch
-- only what changed. Business rules that must hold across devices (ticket
-- numbers, no negative stock, who may change what) are enforced here.

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------------ staff

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('head', 'executive')),
  active boolean not null default true,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_head() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'head');
$$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_staff());

-- ------------------------------------------------------------- app tables

create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception 'Row ids cannot change';
  end if;
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'technicians', 'items', 'customers', 'complaints', 'movements', 'logs', 'alerts', 'cylinders', 'cylinder_moves', 'requests'] loop
    execute format(
      'create table if not exists public.%I (
         id text primary key,
         data jsonb not null,
         updated_at timestamptz not null default clock_timestamp(),
         updated_by uuid
       )', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('alter table public.%I enable row level security', t);
    -- Access is decided by the policies below; signed-out visitors get nothing.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.touch_row()',
      t || '_touch', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (public.is_staff())', t || '_read', t);
  end loop;
end;
$$;

-- Who may write what. Executives run the helpdesk; the Service Head controls
-- settings, technicians, the item catalogue, stock adjustments and alert reviews.

-- Customers and complaints: any staff member.
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert with check (public.is_staff());
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update using (public.is_staff()) with check (public.is_staff());

drop policy if exists complaints_insert on public.complaints;
create policy complaints_insert on public.complaints for insert with check (public.is_staff());
drop policy if exists complaints_update on public.complaints;
create policy complaints_update on public.complaints for update using (public.is_staff()) with check (public.is_staff());

-- Timeline entries and stock movements are append-only.
drop policy if exists logs_insert on public.logs;
create policy logs_insert on public.logs for insert with check (public.is_staff());

drop policy if exists movements_insert on public.movements;
create policy movements_insert on public.movements for insert
  with check (public.is_staff() and (public.is_head() or data ->> 'kind' <> 'Adjustment'));

-- Alerts: staff raise and clear them; only the Service Head marks them reviewed.
drop policy if exists alerts_insert on public.alerts;
create policy alerts_insert on public.alerts for insert
  with check (public.is_staff() and (public.is_head() or coalesce((data ->> 'acknowledged')::boolean, false) = false));
drop policy if exists alerts_update on public.alerts;
create policy alerts_update on public.alerts for update
  using (public.is_staff() and (public.is_head() or coalesce((data ->> 'acknowledged')::boolean, false) = false))
  with check (public.is_staff() and (public.is_head() or coalesce((data ->> 'acknowledged')::boolean, false) = false));

-- Gas cylinders, their weighings and branch requests: any staff member.
do $$
declare
  t text;
begin
  foreach t in array array['cylinders', 'cylinder_moves', 'requests'] loop
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert with check (public.is_staff())', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update using (public.is_staff()) with check (public.is_staff())', t || '_update', t);
  end loop;
end;
$$;

-- Only the Service Head approves or rejects a branch request.
create or replace function public.guard_request_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.data ->> 'status', '') in ('Approved', 'Rejected')
     and coalesce(new.data ->> 'status', '') is distinct from (case when tg_op = 'UPDATE' then old.data ->> 'status' end)
     and auth.uid() is not null and not public.is_head() then
    raise exception 'Only the Service Head can approve or reject requests' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists requests_decision on public.requests;
create trigger requests_decision before insert or update on public.requests
  for each row execute function public.guard_request_decision();

-- Settings, technicians and the item catalogue: Service Head only.
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'technicians', 'items'] loop
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert with check (public.is_head())', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update using (public.is_head()) with check (public.is_head())', t || '_update', t);
  end loop;
end;
$$;

create unique index if not exists items_sku_key on public.items ((data ->> 'sku'));
create unique index if not exists complaints_ticket_key on public.complaints ((data ->> 'ticketNo'));
create index if not exists movements_item_idx on public.movements ((data ->> 'itemId'));

-- ---------------------------------------------------------- ticket numbers

create table if not exists public.ticket_counters (
  stem text primary key,
  last integer not null
);
alter table public.ticket_counters enable row level security;
revoke all on public.ticket_counters from anon, authenticated;

-- Devices create complaints with a temporary TMP-… number; the server gives
-- each one the next number in sequence, e.g. SMX-2026-00042.
create or replace function public.assign_ticket_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prefix text;
  v_stem text;
  seq integer;
  created timestamptz;
begin
  if tg_op = 'UPDATE' then
    -- A device that hasn't yet received the real number must not overwrite it.
    if coalesce(new.data ->> 'ticketNo', '') like 'TMP-%' and coalesce(old.data ->> 'ticketNo', '') not like 'TMP-%' then
      new.data := jsonb_set(new.data, '{ticketNo}', old.data -> 'ticketNo');
    end if;
    return new;
  end if;

  if coalesce(new.data ->> 'ticketNo', '') = '' or new.data ->> 'ticketNo' like 'TMP-%' then
    select coalesce(nullif(data -> 'value' ->> 'ticketPrefix', ''), 'SMX') into prefix from public.settings where id = 'app';
    prefix := coalesce(prefix, 'SMX');
    created := coalesce((new.data ->> 'createdAt')::timestamptz, now());
    v_stem := prefix || '-' || extract(year from created)::int || '-';
    insert into public.ticket_counters as c (stem, last) values (v_stem, 1)
      on conflict (stem) do update set last = c.last + 1
      returning last into seq;
    new.data := jsonb_set(new.data, '{ticketNo}', to_jsonb(v_stem || lpad(seq::text, 5, '0')));
  end if;
  return new;
end;
$$;

-- Records, from the signed-in account, who logged and who closed each
-- complaint, so the names and emails shown can't be typed in by someone else.
create or replace function public.stamp_complaint_actors() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare
  actor_email text;
  actor_name text;
begin
  if auth.uid() is null then
    return new;
  end if;
  select p.email, p.display_name into actor_email, actor_name from public.profiles p where p.id = auth.uid();
  if tg_op = 'INSERT' then
    new.data := new.data || jsonb_build_object('loggedByEmail', actor_email, 'loggedBy', actor_name);
  else
    -- Keep the original author whatever a device sends.
    new.data := new.data || jsonb_build_object('loggedByEmail', old.data -> 'loggedByEmail', 'loggedBy', old.data -> 'loggedBy');
    if new.data ->> 'status' = 'Closed' and coalesce(old.data ->> 'status', '') <> 'Closed' then
      new.data := new.data || jsonb_build_object('closedByEmail', actor_email, 'closedBy', actor_name);
    elsif new.data ->> 'status' = 'Closed' then
      new.data := new.data || jsonb_build_object('closedByEmail', old.data -> 'closedByEmail', 'closedBy', old.data -> 'closedBy');
    else
      new.data := new.data - 'closedByEmail' - 'closedBy';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists complaints_actors on public.complaints;
create trigger complaints_actors before insert or update on public.complaints
  for each row execute function public.stamp_complaint_actors();

create or replace function public.stamp_log_actor() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor_email text;
  actor_name text;
begin
  if auth.uid() is null or new.data ->> 'by' = 'System' then
    return new;
  end if;
  select p.email, p.display_name into actor_email, actor_name from public.profiles p where p.id = auth.uid();
  new.data := new.data || jsonb_build_object('by', actor_name, 'byEmail', actor_email);
  return new;
end;
$$;

drop trigger if exists logs_actor on public.logs;
create trigger logs_actor before insert on public.logs
  for each row execute function public.stamp_log_actor();

drop trigger if exists movements_actor on public.movements;
create trigger movements_actor before insert on public.movements
  for each row execute function public.stamp_log_actor();

drop trigger if exists complaints_ticket on public.complaints;
create trigger complaints_ticket before insert or update on public.complaints
  for each row execute function public.assign_ticket_no();

-- ------------------------------------------------------------ stock level

-- Stock is the sum of an item's movements. Reject a movement that would take
-- it below zero, e.g. two PCs issuing the last cylinder at the same time.
create or replace function public.check_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  total numeric;
  qty numeric := (new.data ->> 'qty')::numeric;
  item_name text;
begin
  -- A retried upload of a movement already stored is ignored by the insert.
  if exists (select 1 from public.movements where id = new.id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('stock:' || (new.data ->> 'itemId')));
  select coalesce(sum((data ->> 'qty')::numeric), 0) into total
    from public.movements where data ->> 'itemId' = new.data ->> 'itemId';
  if qty < 0 and total + qty < 0 then
    select data ->> 'name' into item_name from public.items where id = new.data ->> 'itemId';
    raise exception 'Not enough stock of %: % available', coalesce(item_name, 'this item'), round(total, 3)
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists movements_stock on public.movements;
create trigger movements_stock before insert on public.movements
  for each row execute function public.check_stock();

-- --------------------------------------------------------- staff accounts
-- Staff sign in with their email address and password. Accounts are created
-- by the Service Head, so they are confirmed immediately and no mail is sent.

-- Lets the login screen know whether first-time setup is needed.
create or replace function public.staff_count() returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.profiles;
$$;

create or replace function public.check_password(p_password text) returns void
language plpgsql immutable as $$
begin
  if length(p_password) < 8 or p_password !~ '[A-Za-z]' or p_password !~ '[0-9]' then
    raise exception 'Password must be at least 8 characters and contain letters and numbers' using errcode = 'P0001';
  end if;
end;
$$;

-- Creates a staff account. The very first account (made during setup) must be
-- the Service Head; after that only an active Service Head can add accounts.
create or replace function public.create_staff_user(p_email text, p_display_name text, p_role text, p_password text)
returns uuid
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid := gen_random_uuid();
  mail text := lower(trim(p_email));
  bootstrap boolean;
begin
  perform pg_advisory_xact_lock(hashtext('create_staff_user'));
  bootstrap := not exists (select 1 from public.profiles);
  if not bootstrap and not public.is_head() then
    raise exception 'Only the Service Head can create accounts' using errcode = '42501';
  end if;
  if bootstrap and p_role <> 'head' then
    raise exception 'The first account must be the Service Head' using errcode = 'P0001';
  end if;
  if p_role not in ('head', 'executive') then
    raise exception 'Unknown role %', p_role using errcode = 'P0001';
  end if;
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'Enter the person''s name' using errcode = 'P0001';
  end if;
  perform public.check_password(p_password);
  if exists (select 1 from public.profiles where email = mail) or exists (select 1 from auth.users where lower(email) = mail) then
    raise exception 'An account for % already exists', mail using errcode = 'P0001';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', mail,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
    'email', now(), now(), now()
  );
  insert into public.profiles (id, email, display_name, role, must_change_password)
  values (uid, mail, trim(p_display_name), p_role, not bootstrap);
  return uid;
end;
$$;

-- Service Head sets a temporary password; the person must change it at next login.
create or replace function public.reset_staff_password(p_user_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_head() then
    raise exception 'Only the Service Head can reset passwords' using errcode = '42501';
  end if;
  perform public.check_password(p_password);
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0001';
  end if;
  update public.profiles set must_change_password = (p_user_id <> auth.uid()) where id = p_user_id;
end;
$$;

-- Service Head changes a person's name, role or active status.
create or replace function public.update_staff(p_user_id uuid, p_display_name text, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  target public.profiles;
begin
  if not public.is_head() then
    raise exception 'Only the Service Head can change accounts' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('update_staff'));
  select * into target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0001';
  end if;
  if p_role not in ('head', 'executive') then
    raise exception 'Unknown role %', p_role using errcode = 'P0001';
  end if;
  if target.role = 'head' and target.active and (p_role <> 'head' or not p_active)
     and (select count(*) from public.profiles where role = 'head' and active) <= 1 then
    raise exception 'There must always be at least one active Service Head' using errcode = 'P0001';
  end if;
  update public.profiles
    set display_name = coalesce(nullif(trim(p_display_name), ''), display_name), role = p_role, active = p_active
    where id = p_user_id;
  -- Disabled accounts cannot sign in at all.
  update auth.users set banned_until = case when p_active then null else 'infinity'::timestamptz end where id = p_user_id;
end;
$$;

-- Called by the app after a person sets their own new password.
create or replace function public.password_changed() returns void
language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;

-- ------------------------------------------------------------- demo data
-- Sample records created with "Load demo data" have ids starting "demo-".
-- This removes them all and tells every device to drop its copies.
create or replace function public.purge_demo_data() returns integer
language plpgsql security definer set search_path = public as $$
declare
  t text;
  n integer;
  total integer := 0;
begin
  if not public.is_head() then
    raise exception 'Only the Service Head can remove demo data' using errcode = '42501';
  end if;
  foreach t in array array['alerts', 'logs', 'movements', 'cylinder_moves', 'cylinders', 'requests', 'complaints', 'customers', 'technicians'] loop
    execute format('delete from public.%I where id like %L', t, 'demo-%');
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  -- With no real complaints yet, ticket numbers start again from 1.
  -- (Supabase refuses a DELETE without WHERE, hence "where true".)
  if not exists (select 1 from public.complaints) then
    delete from public.ticket_counters where true;
  end if;
  insert into public.settings (id, data) values ('app', jsonb_build_object('value', jsonb_build_object('demoPurgedAt', now())))
    on conflict (id) do update
    set data = jsonb_set(coalesce(public.settings.data, '{}'::jsonb), '{value}',
      coalesce(public.settings.data -> 'value', '{}'::jsonb) || jsonb_build_object('demoPurgedAt', now()));
  return total;
end;
$$;

revoke all on function public.purge_demo_data() from public;
grant execute on function public.purge_demo_data() to authenticated;

revoke all on function public.create_staff_user(text, text, text, text) from public;
revoke all on function public.reset_staff_password(uuid, text) from public;
revoke all on function public.update_staff(uuid, text, text, boolean) from public;
revoke all on function public.password_changed() from public;
grant execute on function public.staff_count() to anon, authenticated;
grant execute on function public.create_staff_user(text, text, text, text) to anon, authenticated;
grant execute on function public.reset_staff_password(uuid, text) to authenticated;
grant execute on function public.update_staff(uuid, text, text, boolean) to authenticated;
grant execute on function public.password_changed() to authenticated;

-- ---------------------------------------------------------------- realtime
-- Lets each PC hear about changes straight away instead of waiting to poll.

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['settings', 'technicians', 'items', 'customers', 'complaints', 'movements', 'logs', 'alerts', 'profiles', 'cylinders', 'cylinder_moves', 'requests'] loop
      if not exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
