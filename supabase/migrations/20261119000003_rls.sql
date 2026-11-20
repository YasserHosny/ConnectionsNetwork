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

create or replace function public.current_member_role()
returns text
language sql
stable
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'member_role', ''
  );
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
  'The member_role claim (admin | member) from the verified JWT, or NULL.';
comment on function public.current_person_id() is
  'The person_id claim (the caller''s own person) from the verified JWT, or NULL.';

-- ---------------------------------------------------------------------------
-- network: this table IS the network, so the policy compares id, not network_id.
-- The accessors are wrapped in (select ...) so Postgres evaluates them once per statement.
-- ---------------------------------------------------------------------------
alter table public.network enable row level security;
alter table public.network force  row level security;

create policy network_admin on public.network
  for all
  to authenticated
  using      (id = (select public.current_network_id())
              and (select public.current_member_role()) = 'admin')
  with check (id = (select public.current_network_id())
              and (select public.current_member_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- Every network-scoped table: the same admin policy, for all commands.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'member', 'person', 'tag', 'person_skill', 'person_industry', 'social_link',
    'contact_value', 'connection', 'contributor_link', 'duplicate_dismissal'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated'
      '  using      (network_id = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''admin'')'
      '  with check (network_id = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''admin'')',
      t || '_admin', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- RLS narrows what a role may touch; it does not grant access. Both are required. `anon` (a
-- request with no session: contributor links) holds nothing on any table; it reaches data only
-- through narrow SECURITY DEFINER functions (spec 11.4). The explicit revoke also covers hosted
-- projects whose default privileges still auto-grant new tables to anon.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on
  public.network, public.member, public.person, public.tag, public.person_skill,
  public.person_industry, public.social_link, public.contact_value, public.connection,
  public.contributor_link, public.duplicate_dismissal
  to authenticated;

revoke all on
  public.network, public.member, public.person, public.tag, public.person_skill,
  public.person_industry, public.social_link, public.contact_value, public.connection,
  public.contributor_link, public.duplicate_dismissal
  from anon;
