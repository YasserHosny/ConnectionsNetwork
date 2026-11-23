-- connections_api: the database login of the API (ruling R19).
--
-- The API must not connect as the database owner (`postgres`): the owner bypasses row-level
-- security, so a single query that escaped connections_api.db.user_tx would read every network.
-- This role holds NO privilege on any table, function or schema object of its own. All it can do
-- is switch, per transaction, to
--   * authenticated    (db.user_tx: admin requests, under RLS with the verified JWT claims), and
--   * contributor_api  (db.contributor_tx: contributor-link requests, 20261119000008).
-- NOINHERIT and `inherit false` on both grants: the role never holds their privileges without the
-- explicit `set local role`, so a query outside a transaction helper is simply refused.
-- NOBYPASSRLS, not a superuser, cannot create roles or databases.
--
-- NOLOGIN here: no password lives in the repository. At deploy the owner runs
--   alter role connections_api login password '<a generated password>';
-- and points the API's DATABASE_URL at it (docs/operations/deploy-checklist.md). `postgres`
-- stays the role for migrations, scripts/bootstrap_admin.py and the nightly backup.
--
-- Cluster-wide, like contributor_api: created idempotently so it can outlive a dropped database.

do $$
begin
  create role connections_api nologin noinherit nobypassrls nosuperuser nocreaterole nocreatedb;
exception when duplicate_object then null;
end
$$;

-- Postgres 16+ separates the right to `set role` (SET) from inheriting privileges (INHERIT).
grant authenticated, contributor_api to connections_api with inherit false, set true;

comment on role connections_api is
  'The API''s database login. No privileges of its own; switches to authenticated (user_tx) or '
  'contributor_api (contributor_tx). LOGIN and a password are set by the owner at deploy.';
