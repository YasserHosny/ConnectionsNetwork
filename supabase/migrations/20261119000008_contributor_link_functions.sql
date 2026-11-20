-- Contributor links (spec 8.2, 11.4; ADR docs/adr/0001-contributor-link-exception.md).
--
-- A link contributor has no Supabase session and no JWT, so RLS cannot identify them. Their
-- requests reach data only through the three functions below, each of which
--   * takes the sha256 of the link token (the API hashes it; the plaintext never reaches the
--     database, its logs or pg_stat_statements),
--   * validates the link first: it exists, is not revoked and has not expired (expires_at > now()),
--   * uses the LINK's network_id and person_id for everything; the caller has no claims to read.
-- An unknown, expired or revoked link is one case, never told apart: contributor_link_info
-- returns no row, the other two raise `invalid_link` (SQLSTATE 28000,
-- invalid_authorization_specification), which the API answers with the same 404.
--
-- Who may call them: only `contributor_api` (ruling R11), a NOLOGIN role with no table privilege
-- that the API's login role switches to (connections_api.db.contributor_tx). NOT anon: PostgREST
-- exposes every public function to anon, and the anon key ships in the web app, so a grant to anon
-- would let anyone call /rest/v1/rpc/contribute_person directly, past the API's rate limits and
-- its own validation. Execute is revoked from public, anon, authenticated and service_role (hosted
-- default privileges grant new functions to the Supabase roles) and granted to contributor_api
-- alone. PostgREST's `authenticator` is never made a member of contributor_api.
--
-- SECURITY DEFINER: the functions run as their owner, which bypasses RLS (the superuser locally
-- and in CI, `postgres` on hosted; ruling R4). That is why they are narrow: contribute_person
-- only inserts, contributor_link_info returns the contributor's display name and the expiry, and
-- contributor_tag_suggest returns tag labels (not sensitive; they keep contributors on existing
-- spellings, against skill fragmentation). None returns any other row.
--
-- search_path is pinned empty and every name is schema-qualified, so a caller cannot shadow a
-- table, type or function.

-- ---------------------------------------------------------------------------
-- contributor_api: the database role of a contributor-link request. Idempotent, like the
-- stand-ins: it is cluster-wide, so it can outlive a dropped database.
-- ---------------------------------------------------------------------------
do $$
begin
  create role contributor_api nologin;
exception when duplicate_object then null;
end
$$;

grant usage on schema public to contributor_api;
-- The API's login role (postgres locally, in CI and on hosted) may `set role contributor_api`.
grant contributor_api to current_user;

-- ---------------------------------------------------------------------------
-- suggest_tags: the one tag-autocomplete rule, shared by the admin's GET /tags (invoker rights,
-- under RLS, with current_network_id()) and contributor_tag_suggest (the link's network).
-- Prefix matches on the normalized label first, then close spellings (trigram similarity >= 0.3);
-- an alias answers with its target, once; a blank query lists the first tags alphabetically.
-- ---------------------------------------------------------------------------
create or replace function public.suggest_tags(
  p_network_id uuid,
  p_kind       public.tag_kind,
  p_q          text
) returns table (id uuid, label text, category public.skill_category)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.label, m.category from (
    select distinct on (target.id)
           target.id, target.label, target.category, target.label_norm,
           not pg_catalog.starts_with(t.label_norm, q.n) as fuzzy,
           public.similarity(t.label_norm, q.n) as sim
    from public.tag t
    join public.tag target on target.network_id = t.network_id
                          and target.id = coalesce(t.alias_of_tag_id, t.id),
         (select public.normalize_text(coalesce(p_q, '')) as n) q
    where t.network_id = p_network_id
      and t.kind = p_kind
      and (q.n = ''
           or pg_catalog.starts_with(t.label_norm, q.n)
           or public.similarity(t.label_norm, q.n) >= 0.3)
    order by target.id, fuzzy, sim desc
  ) m
  order by m.fuzzy, m.sim desc, m.label_norm, m.id
  limit 10
$$;

comment on function public.suggest_tags(uuid, public.tag_kind, text) is
  'Up to 10 tag suggestions for a typed prefix: prefix matches, then close spellings. Invoker rights.';

revoke all on function public.suggest_tags(uuid, public.tag_kind, text)
  from public, anon, authenticated;
grant execute on function public.suggest_tags(uuid, public.tag_kind, text) to authenticated;

-- ---------------------------------------------------------------------------
-- contributor_link_info: who the link belongs to and until when. Zero rows for a link that is
-- unknown, expired or revoked. The display name is the Arabic one when present, as in the API's
-- people.service.display_name.
-- ---------------------------------------------------------------------------
create or replace function public.contributor_link_info(p_token_hash bytea)
returns table (contributor_display_name text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.name_ar), ''), btrim(p.name_latin)), l.expires_at
  from public.contributor_link l
  join public.person p on p.network_id = l.network_id and p.id = l.person_id
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and l.expires_at > now()
$$;

comment on function public.contributor_link_info(bytea) is
  'Contributor display name and expiry for a valid link token hash; no row otherwise. contributor_api only.';

revoke all on function public.contributor_link_info(bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.contributor_link_info(bytea) to contributor_api;

-- ---------------------------------------------------------------------------
-- contributor_tag_suggest: tag autocomplete for a contributor, in the link's network.
-- ---------------------------------------------------------------------------
create or replace function public.contributor_tag_suggest(
  p_token_hash bytea,
  p_kind       text,
  p_q          text
) returns table (label text, category public.skill_category)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_network_id uuid;
begin
  select l.network_id into v_network_id
  from public.contributor_link l
  where l.token_hash = p_token_hash and l.revoked_at is null and l.expires_at > now();
  if not found then
    raise exception 'invalid_link' using errcode = '28000';
  end if;

  return query
    select s.label, s.category
    from public.suggest_tags(v_network_id, p_kind::public.tag_kind, p_q) s;
end
$$;

comment on function public.contributor_tag_suggest(bytea, text, text) is
  'Tag suggestions in a valid link''s network; raises invalid_link (28000) otherwise.
   contributor_api only.';

revoke all on function public.contributor_tag_suggest(bytea, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.contributor_tag_suggest(bytea, text, text) to contributor_api;

-- ---------------------------------------------------------------------------
-- contribute_person: insert one person through a valid link, connected to the link's person.
--
-- p_payload is the API request body: {"person": {...}, "strength": "strong|normal|weak"}.
-- The person object takes the admin PersonInput fields minus admin_notes. Any other key, a value
-- of the wrong JSON type, an unknown enum value, a text over its length, too many list entries
-- or no name at all raises 22023 (invalid_parameter_value) or 22P02 (an enum cast), before
-- anything is written. The API validates the same rules first (links/schemas.py); this is the
-- database refusing to trust it. Keep the limits below in step with that module.
--
-- Inserted, all in the link's network: the person (created_via 'link', contributor_link_id,
-- created_by_person_id = the link's person), skills (through upsert_tag, so spellings merge with
-- existing tags), industries, social links, contact values (added_by_person_id = the link's
-- person, so the contributor keeps seeing what they entered, spec 7.2) and one connection to the
-- link's person with the given strength. Repeated skills, industries and contact values collapse
-- to one; a stated skill level wins over none. Returns the new person's id; reads nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.contribute_person(p_token_hash bytea, p_payload jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_text     constant int := 200;
  c_max_label    constant int := 100;
  c_max_url      constant int := 500;
  c_max_skills   constant int := 50;
  c_max_tags     constant int := 20;  -- industries
  c_max_links    constant int := 20;  -- social links
  c_max_contacts constant int := 20;
  c_max_avail    constant int := 4;
  c_text_keys    constant text[] := array[
    'name_ar', 'name_latin', 'headline', 'organization', 'profession', 'city', 'country'
  ];
  c_list_keys    constant text[] := array[
    'available_for', 'skills', 'industries', 'social_links', 'contacts'
  ];
  v_link     record;
  v_person   jsonb;
  v_strength public.connection_strength;
  v_key      text;
  v_item     jsonb;
  v_id       uuid;
  v_tag_id   uuid;
begin
  select l.id, l.network_id, l.person_id into v_link
  from public.contributor_link l
  where l.token_hash = p_token_hash and l.revoked_at is null and l.expires_at > now();
  if not found then
    raise exception 'invalid_link' using errcode = '28000';
  end if;

  -- -- validate the whole payload before writing anything ----------------------------------
  if jsonb_typeof(p_payload) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('person', 'strength'))
  then
    raise exception 'payload must be an object with person and strength' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'person') is distinct from 'object' then
    raise exception 'person must be an object' using errcode = '22023';
  end if;
  -- A key sent as JSON null is the same as a key left out.
  v_person := jsonb_strip_nulls(p_payload -> 'person');
  if jsonb_typeof(p_payload -> 'strength') is distinct from 'string' then
    raise exception 'strength is required' using errcode = '22023';
  end if;
  v_strength := (p_payload ->> 'strength')::public.connection_strength;

  -- admin_notes, provenance and any other column are not the contributor's to set.
  select k into v_key from jsonb_object_keys(v_person) k
  where k <> all (c_text_keys || c_list_keys || array['seniority']) limit 1;
  if found then
    raise exception 'person.% is not accepted from a contributor', v_key using errcode = '22023';
  end if;

  foreach v_key in array c_text_keys || array['seniority'] loop
    if coalesce(jsonb_typeof(v_person -> v_key), 'null') not in ('string', 'null') then
      raise exception 'person.% must be text', v_key using errcode = '22023';
    end if;
    if char_length(btrim(v_person ->> v_key)) > c_max_text then
      raise exception 'person.% is too long', v_key using errcode = '22023';
    end if;
  end loop;
  if nullif(btrim(v_person ->> 'name_ar'), '') is null
     and nullif(btrim(v_person ->> 'name_latin'), '') is null then
    raise exception 'name_ar or name_latin is required' using errcode = '22023';
  end if;
  perform (nullif(btrim(v_person ->> 'seniority'), ''))::public.seniority;

  foreach v_key in array c_list_keys loop
    if coalesce(jsonb_typeof(v_person -> v_key), 'null') not in ('array', 'null') then
      raise exception 'person.% must be a list', v_key using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(coalesce(v_person -> 'available_for', '[]')) > c_max_avail
     or jsonb_array_length(coalesce(v_person -> 'skills', '[]')) > c_max_skills
     or jsonb_array_length(coalesce(v_person -> 'industries', '[]')) > c_max_tags
     or jsonb_array_length(coalesce(v_person -> 'social_links', '[]')) > c_max_links
     or jsonb_array_length(coalesce(v_person -> 'contacts', '[]')) > c_max_contacts then
    raise exception 'too many entries in a list' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(v_person -> 'available_for', '[]')) a
    where jsonb_typeof(a) <> 'string'
       or a #>> '{}' <> all (array['job_seeking', 'freelance', 'offers_service', 'partner_seeking'])
  ) then
    raise exception 'person.available_for has an unknown value' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(v_person -> 'industries', '[]')) i
    where jsonb_typeof(i) <> 'string'
       or btrim(i #>> '{}') = '' or char_length(btrim(i #>> '{}')) > c_max_label
  ) then
    raise exception 'person.industries has an invalid label' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(v_person -> 'skills', '[]')) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k
                  where k not in ('label', 'category', 'level'))
       or jsonb_typeof(v_item -> 'label') is distinct from 'string'
       or btrim(v_item ->> 'label') = '' or char_length(btrim(v_item ->> 'label')) > c_max_label
       or jsonb_typeof(v_item -> 'category') is distinct from 'string'
       or coalesce(jsonb_typeof(v_item -> 'level'), 'null') not in ('string', 'null') then
      raise exception 'person.skills has an invalid entry' using errcode = '22023';
    end if;
    perform (v_item ->> 'category')::public.skill_category, (v_item ->> 'level')::public.skill_level;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(v_person -> 'social_links', '[]')) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('kind', 'url'))
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or jsonb_typeof(v_item -> 'url') is distinct from 'string'
       or btrim(v_item ->> 'url') = '' or char_length(btrim(v_item ->> 'url')) > c_max_url then
      raise exception 'person.social_links has an invalid entry' using errcode = '22023';
    end if;
    perform (v_item ->> 'kind')::public.social_link_kind;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(v_person -> 'contacts', '[]')) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('kind', 'value'))
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or jsonb_typeof(v_item -> 'value') is distinct from 'string'
       or btrim(v_item ->> 'value') = ''
       or char_length(btrim(v_item ->> 'value')) > c_max_text then
      raise exception 'person.contacts has an invalid entry' using errcode = '22023';
    end if;
    perform (v_item ->> 'kind')::public.contact_kind;
  end loop;

  -- -- write ------------------------------------------------------------------------------------
  insert into public.person (
    network_id, name_ar, name_latin, headline, organization, profession, seniority,
    available_for, city, country, created_by_person_id, created_via, contributor_link_id
  ) values (
    v_link.network_id,
    nullif(btrim(v_person ->> 'name_ar'), ''),
    nullif(btrim(v_person ->> 'name_latin'), ''),
    nullif(btrim(v_person ->> 'headline'), ''),
    nullif(btrim(v_person ->> 'organization'), ''),
    nullif(btrim(v_person ->> 'profession'), ''),
    (nullif(btrim(v_person ->> 'seniority'), ''))::public.seniority,
    array(
      select distinct a from jsonb_array_elements_text(
        coalesce(v_person -> 'available_for', '[]')) a order by a
    ),
    nullif(btrim(v_person ->> 'city'), ''),
    nullif(btrim(v_person ->> 'country'), ''),
    v_link.person_id,
    'link',
    v_link.id
  ) returning id into v_id;

  for v_item in select * from jsonb_array_elements(coalesce(v_person -> 'skills', '[]')) loop
    v_tag_id := public.upsert_tag(
      v_link.network_id, 'skill'::public.tag_kind, btrim(v_item ->> 'label'),
      (v_item ->> 'category')::public.skill_category
    );
    insert into public.person_skill as ps (network_id, person_id, tag_id, level)
    values (v_link.network_id, v_id, v_tag_id, (v_item ->> 'level')::public.skill_level)
    on conflict (person_id, tag_id) do update set level = coalesce(ps.level, excluded.level);
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(v_person -> 'industries', '[]')) loop
    v_tag_id := public.upsert_tag(
      v_link.network_id, 'industry'::public.tag_kind, btrim(v_item #>> '{}'), null
    );
    insert into public.person_industry (network_id, person_id, tag_id)
    values (v_link.network_id, v_id, v_tag_id)
    on conflict (person_id, tag_id) do nothing;
  end loop;

  insert into public.social_link (network_id, person_id, kind, url)
  select v_link.network_id, v_id, (s ->> 'kind')::public.social_link_kind, btrim(s ->> 'url')
  from jsonb_array_elements(coalesce(v_person -> 'social_links', '[]')) with ordinality e(s, n)
  order by n;

  insert into public.contact_value (network_id, person_id, kind, value, added_by_person_id)
  select v_link.network_id, v_id, d.kind, d.value, v_link.person_id
  from (
    select (c ->> 'kind')::public.contact_kind as kind, btrim(c ->> 'value') as value,
           min(n) as first_seen
    from jsonb_array_elements(coalesce(v_person -> 'contacts', '[]')) with ordinality e(c, n)
    group by 1, 2
  ) d
  order by d.first_seen;

  insert into public.connection
    (network_id, person_a, person_b, strength, created_by_person_id)
  values (
    v_link.network_id, least(v_id, v_link.person_id), greatest(v_id, v_link.person_id),
    v_strength, v_link.person_id
  );

  return v_id;
end
$$;

comment on function public.contribute_person(bytea, jsonb) is
  'Insert one person (and their tags, links, contacts, connection) through a valid link token
   hash; raises invalid_link (28000) otherwise, 22023/22P02 on an invalid payload.
   contributor_api only.';

revoke all on function public.contribute_person(bytea, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.contribute_person(bytea, jsonb) to contributor_api;
