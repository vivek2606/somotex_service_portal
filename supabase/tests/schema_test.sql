-- Tests for schema.sql. Run against a database prepared with stub_supabase.sql:
--   psql -v ON_ERROR_STOP=1 -f stub_supabase.sql -f ../schema.sql -f schema_test.sql
\set ON_ERROR_STOP 1

create or replace function pg_temp.act_as(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), false);
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'Expected error like "%", got "%"', p_like, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected error like "%" but the statement succeeded: %', p_like, p_sql;
end $$;

grant execute on all functions in schema pg_temp to anon, authenticated;

-- 1. First-run setup: anyone may create the first account, and it must be the Service Head.
set role anon;
select pg_temp.act_as(null);
select pg_temp.expect_error($$select public.create_staff_user('exec@x.com', 'E', 'executive', 'secret123')$$, '%first account must be the Service Head%');
select public.create_staff_user('Head@Somotex.com', 'Service Head', 'head', 'secret123') as head_id \gset
select pg_temp.expect_error($$select public.create_staff_user('intruder@x.com', 'I', 'head', 'secret123')$$, '%Only the Service Head%');
reset role;
do $$ begin
  assert (select email from public.profiles) = 'head@somotex.com', 'email stored lower-case';
  assert (select must_change_password from public.profiles) = false, 'setup account need not change password';
  assert (select encrypted_password from auth.users) <> 'secret123', 'password is hashed';
  assert (select count(*) from auth.identities) = 1, 'identity created';
end $$;

-- 2. Head creates executives; validation.
set role authenticated;
select pg_temp.act_as(:'head_id');
select public.create_staff_user('exec1@somotex.com', 'Exec One', 'executive', 'secret123') as exec1 \gset
select public.create_staff_user('exec2@somotex.com', 'Exec Two', 'executive', 'secret123') as exec2 \gset
select pg_temp.expect_error($$select public.create_staff_user('exec1@somotex.com', 'Dup', 'executive', 'secret123')$$, '%already exists%');
select pg_temp.expect_error($$select public.create_staff_user('not-an-email', 'X', 'executive', 'secret123')$$, '%valid email%');
select pg_temp.expect_error($$select public.create_staff_user('x@y.com', 'X', 'executive', 'short')$$, '%at least 8%');
reset role;
do $$ begin
  assert (select must_change_password from public.profiles where email = 'exec1@somotex.com'), 'new executive must change password';
end $$;

-- 3. Executives cannot manage staff, settings, technicians or items.
set role authenticated;
select pg_temp.act_as(:'exec1');
select pg_temp.expect_error($$select public.create_staff_user('x@y.com', 'X', 'executive', 'secret123')$$, '%Only the Service Head%');
select pg_temp.expect_error($$select public.update_staff('$$ || :'exec2' || $$', 'X', 'head', true)$$, '%Only the Service Head%');
select pg_temp.expect_error($$insert into public.settings (id, data) values ('app', '{}')$$, '%row-level security%');
select pg_temp.expect_error($$insert into public.technicians (id, data) values ('t1', '{"name":"T"}')$$, '%row-level security%');
select pg_temp.expect_error($$insert into public.items (id, data) values ('i1', '{"sku":"X"}')$$, '%row-level security%');

-- 4. Head sets up settings, a technician and an item.
select pg_temp.act_as(:'head_id');
insert into public.settings (id, data) values ('app', '{"value": {"ticketPrefix": "SMX"}}');
insert into public.technicians (id, data) values ('t1', '{"name": "Tech"}');
insert into public.items (id, data) values ('r32', '{"sku": "REF-R32", "name": "R-32"}');
select pg_temp.expect_error($$insert into public.items (id, data) values ('r32b', '{"sku": "REF-R32"}')$$, '%duplicate key%');

-- 5. Complaints get server ticket numbers and trusted author/closer emails.
select pg_temp.act_as(:'exec1');
insert into public.complaints (id, data) values
  ('c1', '{"ticketNo": "TMP-AAAA", "status": "Registered", "createdAt": "2026-09-28T10:00:00Z", "loggedBy": "Someone Else", "loggedByEmail": "fake@x.com"}'),
  ('c2', '{"ticketNo": "TMP-BBBB", "status": "Registered", "createdAt": "2026-09-28T11:00:00Z"}');
do $$ begin
  assert (select data ->> 'ticketNo' from public.complaints where id = 'c1') = 'SMX-2026-00001', 'first ticket number';
  assert (select data ->> 'ticketNo' from public.complaints where id = 'c2') = 'SMX-2026-00002', 'second ticket number';
  assert (select data ->> 'loggedByEmail' from public.complaints where id = 'c1') = 'exec1@somotex.com', 'author email stamped from account';
  assert (select data ->> 'loggedBy' from public.complaints where id = 'c1') = 'Exec One', 'author name stamped from account';
end $$;

-- Another executive closes it; a stale device still holding TMP- doesn't overwrite the number.
select pg_temp.act_as(:'exec2');
update public.complaints set data = '{"ticketNo": "TMP-AAAA", "status": "Closed", "loggedByEmail": "fake@x.com"}' where id = 'c1';
do $$ begin
  assert (select data ->> 'ticketNo' from public.complaints where id = 'c1') = 'SMX-2026-00001', 'real ticket number kept';
  assert (select data ->> 'closedByEmail' from public.complaints where id = 'c1') = 'exec2@somotex.com', 'closer email stamped';
  assert (select data ->> 'loggedByEmail' from public.complaints where id = 'c1') = 'exec1@somotex.com', 'author email preserved';
  assert (select updated_by from public.complaints where id = 'c1') = current_setting('request.jwt.claim.sub')::uuid, 'updated_by stamped';
end $$;
-- Re-saving a closed complaint keeps the original closer; re-opening clears it.
select pg_temp.act_as(:'exec1');
update public.complaints set data = data || '{"resolution": "x"}' where id = 'c1';
do $$ begin
  assert (select data ->> 'closedByEmail' from public.complaints where id = 'c1') = 'exec2@somotex.com', 'closer preserved on later edits';
end $$;
update public.complaints set data = data || '{"status": "In Progress"}' where id = 'c1';
do $$ begin
  assert (select data ->> 'closedByEmail' from public.complaints where id = 'c1') is null, 'closer cleared on re-open';
end $$;

-- 6. Stock can't go negative; executives can't post adjustments; retries are harmless.
insert into public.movements (id, data) values ('m1', '{"itemId": "r32", "kind": "Receipt", "qty": 5}');
insert into public.movements (id, data) values ('m2', '{"itemId": "r32", "kind": "Issue", "qty": -4}');
select pg_temp.expect_error($$insert into public.movements (id, data) values ('m3', '{"itemId": "r32", "kind": "Issue", "qty": -2}')$$, '%Not enough stock of R-32%');
insert into public.movements (id, data) values ('m2', '{"itemId": "r32", "kind": "Issue", "qty": -4}') on conflict (id) do nothing;
select pg_temp.expect_error($$insert into public.movements (id, data) values ('m4', '{"itemId": "r32", "kind": "Adjustment", "qty": 1}')$$, '%row-level security%');
update public.movements set data = '{}' where id = 'm1';
reset role;
do $$ begin
  assert (select data ->> 'qty' from public.movements where id = 'm1') = '5', 'movements cannot be edited';
  assert (select data ->> 'byEmail' from public.movements where id = 'm1') = 'exec1@somotex.com', 'movement stamped with email';
end $$;

-- 7. Alerts: executives raise and clear, only the head reviews.
set role authenticated;
select pg_temp.act_as(:'exec1');
insert into public.alerts (id, data) values ('a1', '{"acknowledged": false}');
select pg_temp.expect_error($$update public.alerts set data = '{"acknowledged": true}' where id = 'a1'$$, '%row-level security%');
select pg_temp.act_as(:'head_id');
update public.alerts set data = '{"acknowledged": true}' where id = 'a1';
select pg_temp.act_as(:'exec1');
update public.alerts set data = '{"acknowledged": false}' where id = 'a1';
reset role;
do $$ begin
  assert (select data ->> 'acknowledged' from public.alerts where id = 'a1') = 'true', 'executive cannot un-review an alert';
end $$;
set role authenticated;
select pg_temp.act_as(:'exec1');

-- 8. Logs are stamped with the account; "System" entries are left alone.
insert into public.logs (id, data) values ('l1', '{"complaintId": "c1", "by": "Pretender", "text": "hi"}');
insert into public.logs (id, data) values ('l2', '{"complaintId": "c1", "by": "System", "text": "alert"}');
reset role;
do $$ begin
  assert (select data ->> 'byEmail' from public.logs where id = 'l1') = 'exec1@somotex.com', 'log email stamped';
  assert (select data ->> 'by' from public.logs where id = 'l1') = 'Exec One', 'log name stamped';
  assert (select data ->> 'by' from public.logs where id = 'l2') = 'System', 'system entries untouched';
end $$;

-- 9. Staff management: keep one head; disabled staff lose all access.
set role authenticated;
select pg_temp.act_as(:'head_id');
select pg_temp.expect_error($$select public.update_staff('$$ || :'head_id' || $$', 'Head', 'executive', true)$$, '%at least one active Service Head%');
select public.update_staff(:'exec2', 'Exec Two', 'executive', false);
select public.reset_staff_password(:'exec1', 'newpass123');
select pg_temp.act_as(:'exec2');
do $$ begin
  assert (select count(*) from public.complaints) = 0, 'disabled user sees nothing';
end $$;
select pg_temp.act_as(:'exec1');
select public.password_changed();
reset role;
do $$ begin
  assert (select banned_until from auth.users where email = 'exec2@somotex.com') = 'infinity', 'disabled user banned from sign-in';
  assert not (select must_change_password from public.profiles where email = 'exec1@somotex.com'), 'password change recorded';
end $$;

-- 10. Several movements in one upload are checked in order.
set role authenticated;
select pg_temp.act_as(:'exec1');
insert into public.movements (id, data) values
  ('mb1', '{"itemId": "r32", "kind": "Receipt", "qty": 3}'),
  ('mb2', '{"itemId": "r32", "kind": "Issue", "qty": -3.5}');
select pg_temp.expect_error($$insert into public.movements (id, data) values
  ('mb3', '{"itemId": "r32", "kind": "Issue", "qty": -1}'), ('mb4', '{"itemId": "r32", "kind": "Receipt", "qty": 5}')$$, '%Not enough stock%');

-- 11. Demo data: only the head removes it; real rows stay; devices are told.
insert into public.customers (id, data) values ('demo-c1', '{"name": "Demo"}'), ('real-c1', '{"name": "Real"}');
select pg_temp.expect_error($$select public.purge_demo_data()$$, '%Only the Service Head%');
select pg_temp.act_as(:'head_id');
insert into public.complaints (id, data) values ('demo-x1', '{"ticketNo": "TMP-D1", "status": "Registered", "createdAt": "2026-09-28T12:00:00Z"}');
insert into public.movements (id, data) values ('demo-m1', '{"itemId": "r32", "kind": "Receipt", "qty": 1}');
select public.purge_demo_data();
reset role;
do $$ begin
  assert not exists (select 1 from public.customers where id = 'demo-c1'), 'demo customer removed';
  assert exists (select 1 from public.customers where id = 'real-c1'), 'real customer kept';
  assert not exists (select 1 from public.complaints where id like 'demo-%'), 'demo complaint removed';
  assert not exists (select 1 from public.movements where id like 'demo-%'), 'demo movement removed';
  assert (select data -> 'value' ->> 'demoPurgedAt' from public.settings where id = 'app') is not null, 'devices told';
  assert (select data -> 'value' ->> 'ticketPrefix' from public.settings where id = 'app') = 'SMX', 'other settings kept';
  assert exists (select 1 from public.ticket_counters), 'counter kept while real complaints exist';
end $$;

-- 12. Cylinders and branch requests: staff write; only the head approves.
set role authenticated;
select pg_temp.act_as(:'exec1');
insert into public.cylinders (id, data) values ('cy1', '{"tag": "R32-01", "status": "In store"}');
insert into public.cylinder_moves (id, data) values ('cm1', '{"cylinderId": "cy1", "outReading": 17.5}');
update public.cylinder_moves set data = data || '{"inReading": 16.3}' where id = 'cm1';
insert into public.requests (id, data) values ('rq1', '{"ref": "REQ-1", "status": "Requested", "branch": "Abuja"}');
select pg_temp.expect_error($$update public.requests set data = data || '{"status": "Approved"}' where id = 'rq1'$$, '%Only the Service Head%');
select pg_temp.expect_error($$insert into public.requests (id, data) values ('rq2', '{"status": "Approved"}')$$, '%Only the Service Head%');
insert into public.movements (id, data) values ('ml1', '{"itemId": "r32", "kind": "Receipt", "qty": 2}'), ('ml2', '{"itemId": "r32", "kind": "Loss", "qty": -0.5}');
select pg_temp.act_as(:'head_id');
update public.requests set data = data || '{"status": "Approved"}' where id = 'rq1';
select pg_temp.act_as(:'exec1');
update public.requests set data = data || '{"status": "Dispatched"}' where id = 'rq1';
reset role;
do $$ begin
  assert (select data ->> 'inReading' from public.cylinder_moves where id = 'cm1') = '16.3', 'weigh-in saved';
  assert (select data ->> 'status' from public.requests where id = 'rq1') = 'Dispatched', 'request moved on by staff after approval';
end $$;

-- 14. Tools and part returns: staff write; tool history is append-only and stamped.
set role authenticated;
select pg_temp.act_as(:'exec1');
insert into public.tools (id, data) values ('tl1', '{"tag": "VP-01", "kind": "Vacuum pump", "status": "In store"}');
update public.tools set data = data || '{"status": "Issued"}' where id = 'tl1';
insert into public.tool_moves (id, data) values ('tm1', '{"toolId": "tl1", "kind": "Issued", "by": "Someone Else"}');
update public.tool_moves set data = data || '{"kind": "Returned"}' where id = 'tm1';
insert into public.part_returns (id, data) values ('pr1', '{"ref": "RTN-1", "stage": "At site", "partName": "PCB"}');
update public.part_returns set data = data || '{"stage": "Received in Lagos"}' where id = 'pr1';
reset role;
do $$ begin
  assert (select data ->> 'byEmail' from public.tool_moves where id = 'tm1') = 'exec1@somotex.com', 'tool move stamped with the signed-in account';
  assert (select data ->> 'kind' from public.tool_moves where id = 'tm1') = 'Issued', 'tool history cannot be edited';
  assert (select data ->> 'stage' from public.part_returns where id = 'pr1') = 'Received in Lagos', 'return updated';
end $$;

-- 15. Customer links: status and rating by token, without signing in.
insert into public.technicians (id, data) values ('tech-1', '{"name": "Emeka Nwankwo"}');
set role authenticated;
select pg_temp.act_as(:'exec1');
insert into public.complaints (id, data) values ('cx1', jsonb_build_object(
  'ticketNo', 'TMP-X1', 'status', 'In Progress', 'createdAt', '2026-09-20T09:00:00Z', 'publicToken', '0123456789abcdef0123456789abcdef',
  'technicianId', 'tech-1', 'complaintType', 'Not cooling', 'equipment', jsonb_build_object('brand', 'Midea', 'category', 'Residential AC'),
  'description', 'internal note', 'customerId', 'real-c1'));
set role anon;
select pg_temp.act_as(null);
do $$
declare t jsonb := public.public_ticket('0123456789abcdef0123456789abcdef');
begin
  assert t ->> 'status' = 'In Progress', 'status visible';
  assert t ->> 'technician' = 'Emeka', 'technician first name only';
  assert t ->> 'product' = 'Midea Residential AC', 'product';
  assert t ->> 'ticketNo' like 'SMX-%', 'real ticket number';
  assert not (t ? 'description') and not (t ? 'customerId'), 'nothing internal is shown';
  assert public.public_ticket('ffffffffffffffffffffffffffffffff') is null, 'unknown token';
  assert public.public_ticket('x'' or 1=1 --') is null, 'malformed token';
end $$;
select pg_temp.expect_error($$select public.submit_feedback('0123456789abcdef0123456789abcdef', 5, 'Great')$$, '%once the job is complete%');
reset role;
update public.complaints set data = data || '{"status": "Closed"}' where id = 'cx1';
set role anon;
select pg_temp.expect_error($$select public.submit_feedback('0123456789abcdef0123456789abcdef', 9, '')$$, '%1 to 5%');
select public.submit_feedback('0123456789abcdef0123456789abcdef', 4, '  Technician was polite  ');
select pg_temp.expect_error($$select public.submit_feedback('0123456789abcdef0123456789abcdef', 1, 'again')$$, '%already been recorded%');
reset role;
-- A device that still has the old copy can't overwrite the customer's rating.
set role authenticated;
select pg_temp.act_as(:'exec1');
update public.complaints set data = (data - 'feedbackVia' - 'feedbackComment') || '{"customerFeedback": 1}' where id = 'cx1';
reset role;
do $$
declare d jsonb := (select data from public.complaints where id = 'cx1');
begin
  assert (d ->> 'customerFeedback')::int = 4, 'customer rating kept';
  assert d ->> 'feedbackVia' = 'customer', 'source kept';
  assert d ->> 'feedbackComment' = 'Technician was polite', 'comment trimmed and kept';
  assert exists (select 1 from public.logs where data ->> 'complaintId' = 'cx1' and data ->> 'by' = 'Customer'), 'timeline entry added';
end $$;

-- 13. Anonymous visitors see nothing but the staff count.
set role anon;
select pg_temp.act_as(null);
do $$ begin
  assert public.staff_count() = 3, 'staff count';
end $$;
select pg_temp.expect_error($$select count(*) from public.complaints$$, '%permission denied%');
select pg_temp.expect_error($$select count(*) from public.profiles$$, '%permission denied%');
select pg_temp.expect_error($$insert into public.customers (id, data) values ('x', '{}')$$, '%permission denied%');
select pg_temp.expect_error($$select count(*) from public.tools$$, '%permission denied%');
select pg_temp.expect_error($$select count(*) from public.part_returns$$, '%permission denied%');
reset role;

\echo 'All schema tests passed'
