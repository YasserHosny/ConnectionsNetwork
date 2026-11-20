-- Network-scoped row-level security and the admin policy (spec 11.3), after PP's 0004_rls.sql.
--
-- Isolation is enforced by the DATABASE, not by application diligence: a forgotten
-- `where network_id = ...` in the API must not be able to leak another network's data. Three
-- details carry that, and all three are load-bearing:
--
--   1. ENABLE row level security - turns policies on for ordinary roles.
--   2. FORCE  row level security - applies them to the TABLE OWNER too; without it the owning
--                                  role bypasses every policy silently.
--   3. USING *and* WITH CHECK    - USING decides which rows are visible (and which an update or
--                                  delete can reach); WITH CHECK decides which rows may be
--                                  WRITTEN. A USING-only policy would let an admin insert a row
--                                  carrying another network's id.
--
-- The claims come from the verified JWT, stamped by the access token hook (20261119000004) and
-- set per transaction by connections_api.db.user_tx. Never from a header, path or query.
--
-- This migration grants the ADMIN only. Member visibility (spec 7.1/7.2) is a later migration;
-- until then a member's token matches no policy and sees nothing.

-- ---------------------------------------------------------------------------
-- Claim accessors
--
-- Each returns NULL rather than raising when the claims or the claim are absent, so a policy
-- comparison yields NULL -> false (deny) instead of an error. Fail closed, quietly. The claims
-- setting reads as '' (not NULL) once a transaction-local value has ended, hence the nullif.
-- ---------------------------------------------------------------------------
create or replace function public.current_network_id()
returns uuid
language sql
stable
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'network_id', ''
  )::uuid;
$$;

-- 'admin' only for a session that completed TOTP MFA (`aal` = 'aal2', spec 10). The API checks
-- the same thing, but hosted Supabase also serves this schema's tables to whoever holds the public
-- anon key and a session, so a password-only (aal1) admin session must match no admin policy
-- here either: it reads as no role at all. merge_persons and every admin policy inherit this.
-- The member role does not depend on aal (members are not required to use MFA).
create or replace function public.current_member_role()
returns text
language sql
stable
as $$
  select case
    when c ->> 'member_role' = 'admin' and c ->> 'aal' is distinct from 'aal2' then null
    else nullif(c ->> 'member_role', '')
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) claims;
$$;

create or replace function public.current_person_id()
returns uuid
language sql
stable
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'person_id', ''
  )::uuid;
$$;

comment on function public.current_network_id() is
  'The network_id claim from the verified JWT, or NULL. NULL denies every network policy.';
comment on function public.current_member_role() is
  'The member_role claim (admin | member) from the verified JWT, or NULL. admin needs aal = aal2.';
comment on function public.current_person_id() is
  'The person_id claim (the caller''s own person) from the verified JWT, or NULL.';

-- ---------------------------------------------------------------------------
-- Every table: RLS enabled and forced, the admin policy for all commands, and the grants.
-- The one list of tables; a table added later goes here, and nowhere else.
--
-- `network` IS the network, so its policy compares id, not network_id. The accessors are wrapped
-- in (select ...) so Postgres evaluates them once per statement.
--
-- Grants: RLS narrows what a role may touch; it does not grant access. Both are required.
--   * authenticated gets select, insert, update, delete and nothing else. Hosted Supabase's
--     default privileges hand it ALL on new tables; TRUNCATE ignores RLS (any signed-in session
--     could empty a table), and REFERENCES and TRIGGER are not needed, so all three are revoked.
--   * anon (a request with no session) holds nothing on any table: contributor links reach data
--     only through narrow SECURITY DEFINER functions (spec 11.4) run as contributor_api.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

do $$
declare
  t      text;
  scoped text;
begin
  foreach t in array array[
    'network', 'member', 'person', 'tag', 'person_skill', 'person_industry', 'social_link',
    'contact_value', 'connection', 'contributor_link', 'duplicate_dismissal'
  ] loop
    scoped := case when t = 'network' then 'id' else 'network_id' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated'
      '  using      (%I = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''admin'')'
      '  with check (%I = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''admin'')',
      t || '_admin', t, scoped, scoped);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Default privileges: what a LATER migration creates must not inherit the hosted grants either.
-- Per schema, for the role running the migrations. Functions keep Postgres's built-in EXECUTE
-- for PUBLIC, which a per-schema default cannot remove: every function revokes it itself.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
