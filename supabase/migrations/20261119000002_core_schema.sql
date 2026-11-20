-- Core schema: the network, its members, people, tags, contact details and connections.
--
-- Every table except `network` carries `network_id uuid not null` (spec 11.3): phase 1 has one
-- network, but RLS (20261119000003_rls.sql) scopes every row by it from day one, so opening the
-- product later never means rewriting policies over real data.
--
-- Deletes (spec 9): deleting a person removes everything stored about them. Every `person_id`
-- reference cascades; `connection` and `duplicate_dismissal` cascade from both ends. Provenance
-- references (`created_by_person_id`, `added_by_person_id`) are set null instead, so the people a
-- deleted contributor added are kept. Deleting a network removes everything in it.
--
-- References never cross networks. Foreign-key checks bypass RLS, so a plain `references
-- person (id)` would let an admin of network A point a row in A at network B's person or tag
-- (and SECURITY DEFINER functions would trust it). Every reference between network-scoped rows
-- is therefore composite, `(network_id, x_id) references t (network_id, id)`, backed by
-- `unique (network_id, id)` on person, tag and contributor_link. Set-null references use the
-- column-list form `on delete set null (x_id)`, so network_id itself is never nulled.
--
-- Normalized columns are GENERATED from the normalize_* functions (20261119000001), so the
-- canonical form can never drift from what was typed.

-- ---------------------------------------------------------------------------
-- Value sets (global constraints). Enum order is meaningful where noted.
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('admin', 'member');
create type public.member_status as enum ('active', 'disabled');
-- Strongest first: min(strength) is the strongest of a set.
create type public.connection_strength as enum ('strong', 'normal', 'weak');
-- Lowest first: max(level) is the highest of a set.
create type public.skill_level as enum ('basic', 'good', 'expert');
create type public.skill_category as enum (
  'technical', 'languages', 'sports', 'arts_literature', 'culture', 'crafts_trades', 'business',
  'other'
);
create type public.seniority as enum ('employee', 'manager', 'decision_maker', 'business_owner');
create type public.social_link_kind as enum (
  'facebook', 'x', 'linkedin', 'instagram', 'github', 'website'
);
create type public.contact_kind as enum ('phone', 'whatsapp', 'email');
create type public.tag_kind as enum ('skill', 'industry');
create type public.created_via as enum ('admin', 'link');

-- ---------------------------------------------------------------------------
-- network: the set of all data. This table IS the network, so it has no network_id.
-- ---------------------------------------------------------------------------
create table public.network (
  id   uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '')
);

-- ---------------------------------------------------------------------------
-- person: one real human (spec 7). The owner is a person too.
-- ---------------------------------------------------------------------------
create table public.person (
  id                   uuid primary key default gen_random_uuid(),
  network_id           uuid not null references public.network (id) on delete cascade,
  name_ar              text,
  name_latin           text,
  headline             text,
  organization         text,
  profession           text,
  seniority            public.seniority,
  available_for        text[] not null default '{}',
  city                 text,
  country              text,
  admin_notes          text,
  photo_path           text,  -- unused by the v0.1 UI
  last_confirmed_at    timestamptz not null default now(),
  created_by_person_id uuid,
  created_via          public.created_via not null default 'admin',
  contributor_link_id  uuid,  -- foreign key added below, once contributor_link exists
  created_at           timestamptz not null default now(),
  -- Arabic and Latin names together, folded for Arabic-aware search and autocomplete.
  search_name          text not null generated always as (
    public.normalize_text(coalesce(name_ar, '') || ' ' || coalesce(name_latin, ''))
  ) stored,

  constraint person_network_id_unique unique (network_id, id),
  constraint person_created_by_fk foreign key (network_id, created_by_person_id)
    references public.person (network_id, id) on delete set null (created_by_person_id),
  constraint person_has_a_name check (
    nullif(btrim(name_ar), '') is not null or nullif(btrim(name_latin), '') is not null
  ),
  constraint person_available_for_known check (
    available_for <@ array['job_seeking', 'freelance', 'offers_service', 'partner_seeking']
  )
);

create index person_search_name_trgm on public.person using gin (search_name gin_trgm_ops);
create index person_created_by_idx on public.person (created_by_person_id);
create index person_contributor_link_idx on public.person (contributor_link_id);

-- ---------------------------------------------------------------------------
-- member: an account's role in a network, tied to exactly one person.
-- One account belongs to one network (unique user_id): the access token hook stamps that one.
-- ---------------------------------------------------------------------------
create table public.member (
  id         uuid primary key default gen_random_uuid(),
  network_id uuid not null references public.network (id) on delete cascade,
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  person_id  uuid not null unique,
  role       public.member_role not null,
  status     public.member_status not null default 'active',
  created_at timestamptz not null default now(),

  constraint member_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- tag: skill and industry tags. Variants merge on label_norm; an alias points at its target.
-- ---------------------------------------------------------------------------
create table public.tag (
  id              uuid primary key default gen_random_uuid(),
  network_id      uuid not null references public.network (id) on delete cascade,
  kind            public.tag_kind not null,
  category        public.skill_category,
  label           text not null check (btrim(label) <> ''),
  label_norm      text not null generated always as (public.normalize_text(label)) stored,
  alias_of_tag_id uuid,

  constraint tag_network_id_unique unique (network_id, id),
  constraint tag_alias_of_fk foreign key (network_id, alias_of_tag_id)
    references public.tag (network_id, id) on delete set null (alias_of_tag_id),
  constraint tag_label_unique unique (network_id, kind, label_norm),
  -- Skills carry a category; industries do not.
  constraint tag_category_iff_skill check ((kind = 'skill') = (category is not null)),
  constraint tag_not_own_alias check (alias_of_tag_id <> id)
);

create index tag_alias_of_idx on public.tag (alias_of_tag_id);

create table public.person_skill (
  network_id uuid not null references public.network (id) on delete cascade,
  person_id  uuid not null,
  tag_id     uuid not null,
  level      public.skill_level,
  primary key (person_id, tag_id),
  constraint person_skill_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade,
  constraint person_skill_tag_fk foreign key (network_id, tag_id)
    references public.tag (network_id, id) on delete cascade
);

create index person_skill_tag_idx on public.person_skill (tag_id);

create table public.person_industry (
  network_id uuid not null references public.network (id) on delete cascade,
  person_id  uuid not null,
  tag_id     uuid not null,
  primary key (person_id, tag_id),
  constraint person_industry_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade,
  constraint person_industry_tag_fk foreign key (network_id, tag_id)
    references public.tag (network_id, id) on delete cascade
);

create index person_industry_tag_idx on public.person_industry (tag_id);

-- ---------------------------------------------------------------------------
-- social_link and contact_value. The *_norm columns back exact-match duplicate lookups.
-- ---------------------------------------------------------------------------
create table public.social_link (
  id         uuid primary key default gen_random_uuid(),
  network_id uuid not null references public.network (id) on delete cascade,
  person_id  uuid not null,
  kind       public.social_link_kind not null,
  url        text not null,
  url_norm   text generated always as (public.normalize_url(url)) stored,

  constraint social_link_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade
);

create index social_link_person_idx on public.social_link (person_id);
create index social_link_url_norm_idx on public.social_link (network_id, url_norm);

-- Each contact value records who entered it (spec 7.2): visibility is per value, not per person.
create table public.contact_value (
  id                 uuid primary key default gen_random_uuid(),
  network_id         uuid not null references public.network (id) on delete cascade,
  person_id          uuid not null,
  kind               public.contact_kind not null,
  value              text not null,
  -- phone and whatsapp share one normal form, so the same number matches across the two kinds.
  value_norm         text generated always as (
    case
      when kind = 'email' then public.normalize_email(value)
      else public.normalize_phone(value)
    end
  ) stored,
  added_by_person_id uuid,

  constraint contact_value_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade,
  constraint contact_value_added_by_fk foreign key (network_id, added_by_person_id)
    references public.person (network_id, id) on delete set null (added_by_person_id)
);

create index contact_value_person_idx on public.contact_value (person_id);
create index contact_value_added_by_idx on public.contact_value (added_by_person_id);
create index contact_value_value_norm_idx on public.contact_value (network_id, value_norm);

-- ---------------------------------------------------------------------------
-- connection: undirected. Stored once per pair with person_a < person_b, which also rules out a
-- self-loop; the unique pair rejects a second connection between the same two people.
-- ---------------------------------------------------------------------------
create table public.connection (
  id                   uuid primary key default gen_random_uuid(),
  network_id           uuid not null references public.network (id) on delete cascade,
  person_a             uuid not null,
  person_b             uuid not null,
  strength             public.connection_strength not null,
  note                 text,
  created_by_person_id uuid,
  created_at           timestamptz not null default now(),

  constraint connection_person_a_fk foreign key (network_id, person_a)
    references public.person (network_id, id) on delete cascade,
  constraint connection_person_b_fk foreign key (network_id, person_b)
    references public.person (network_id, id) on delete cascade,
  constraint connection_created_by_fk foreign key (network_id, created_by_person_id)
    references public.person (network_id, id) on delete set null (created_by_person_id),

  constraint connection_ordered_pair check (person_a < person_b),
  constraint connection_pair_unique unique (network_id, person_a, person_b)
);

create index connection_person_b_idx on public.connection (person_b);
create index connection_created_by_idx on public.connection (created_by_person_id);

-- ---------------------------------------------------------------------------
-- contributor_link: only the sha256 of the token is stored (spec 11.4).
-- ---------------------------------------------------------------------------
create table public.contributor_link (
  id         uuid primary key default gen_random_uuid(),
  network_id uuid not null references public.network (id) on delete cascade,
  person_id  uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),

  constraint contributor_link_network_id_unique unique (network_id, id),
  constraint contributor_link_person_fk foreign key (network_id, person_id)
    references public.person (network_id, id) on delete cascade
);

create index contributor_link_person_idx on public.contributor_link (person_id);

alter table public.person
  add constraint person_contributor_link_fk
  foreign key (network_id, contributor_link_id)
  references public.contributor_link (network_id, id) on delete set null (contributor_link_id);

-- ---------------------------------------------------------------------------
-- duplicate_dismissal: a pair the admin reviewed and marked "not the same person".
-- ---------------------------------------------------------------------------
create table public.duplicate_dismissal (
  network_id uuid not null references public.network (id) on delete cascade,
  person_a   uuid not null,
  person_b   uuid not null,
  primary key (person_a, person_b),
  constraint duplicate_dismissal_person_a_fk foreign key (network_id, person_a)
    references public.person (network_id, id) on delete cascade,
  constraint duplicate_dismissal_person_b_fk foreign key (network_id, person_b)
    references public.person (network_id, id) on delete cascade,
  constraint duplicate_dismissal_ordered_pair check (person_a < person_b)
);

create index duplicate_dismissal_person_b_idx on public.duplicate_dismissal (person_b);
