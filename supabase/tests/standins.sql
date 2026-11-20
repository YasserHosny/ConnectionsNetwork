-- Stand-ins for what Supabase provides and a bare Postgres does not.
--
-- The migrations reference auth.users and grant to the Supabase roles. Hosted Supabase and the
-- local Supabase CLI both ship these; the throwaway Postgres used by scripts/test-db.sh and by
-- CI's `backend-tests` job does not. Both apply THIS file before supabase/migrations/*.sql, so
-- there is exactly one copy of the stand-ins. Idempotent: safe to apply twice.

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin noinherit login password 'postgres'; exception when duplicate_object then null; end $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant anon, authenticated, service_role to postgres;

-- Hosted Supabase's default privileges: whatever the migration role creates in `public` is
-- granted to the API roles, TRUNCATE (which ignores RLS) and EXECUTE included. The migrations
-- must take that back themselves (20261119000003_rls.sql); emulating the hosted defaults here
-- makes the tests see what hosted would.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
