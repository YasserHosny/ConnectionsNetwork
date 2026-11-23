-- Custom access token hook (spec 11.3), after PP's 0006_auth_hook.sql.
--
-- RLS reads network_id, member_role and person_id from the JWT (20261119000003): a policy cannot
-- call back into application code, so the values must be inside the token at issuance. Supabase
-- Auth calls this hook on every issuance and refresh, so a member being disabled or changing
-- role takes effect at the next refresh rather than being frozen into the account.
--
-- Contract (Supabase Auth, pg-functions hook): receives
--   {"user_id": "<uuid>", "claims": {...}, "authentication_method": "..."}
-- and returns the same object with `claims` replaced. Registered in supabase/config.toml
-- ([auth.hook.custom_access_token]) and, on hosted, in the dashboard's Auth Hooks page.
--
-- DO NOT write the member's role into the `role` claim. Supabase and PostgREST use `role` as the
-- POSTGRES role for the request (`authenticated`, `anon`, `service_role`); 'admin' there would
-- make every request fail with 'role "admin" does not exist'. The member's role travels as the
-- separate `member_role` claim and `role` is left exactly as Supabase set it.
--
-- SECURITY DEFINER: Supabase Auth calls this as supabase_auth_admin, which has no access to
-- `member`. The function runs as its owner, which bypasses RLS (the superuser locally and in CI,
-- `postgres` on hosted, as in PP; ruling R4). It reads one row by user_id and nothing else.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  active record;
begin
  claims := coalesce(event -> 'claims', '{}'::jsonb);

  -- member.user_id is unique: an account belongs to exactly one network.
  select m.network_id, m.role, m.person_id
    into active
  from public.member m
  where m.user_id = (event ->> 'user_id')::uuid
    and m.status = 'active';

  if found then
    claims := claims || jsonb_build_object(
      'network_id',  active.network_id::text,
      'member_role', active.role::text,
      'person_id',   active.person_id::text
    );
  else
    -- No active member: a token with NO network claims. current_network_id() is then NULL and
    -- every network-scoped policy denies: a disabled account sees nothing.
    claims := claims - 'network_id' - 'member_role' - 'person_id';
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

comment on function public.custom_access_token_hook(jsonb) is
  'Stamps network_id, member_role and person_id into the access token from the caller''s active
   member row. Never touches the `role` claim, which Postgres/PostgREST reserve for the database
   role. Register as the custom access token hook in Supabase Auth configuration.';
