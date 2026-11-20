-- Extensions and the normalize_* functions.
--
-- The normalizers turn what a person typed into a canonical form, so that the same thing written
-- differently compares equal: duplicate detection (phone, email, social URL) and Arabic-aware
-- search (names, tags). Later migrations use them in generated columns and indexes, so each one
-- is IMMUTABLE: a pure function of its argument, with nothing read from session settings.
--   * `set search_path = ''` pins name resolution; every function and operator used below is
--     in pg_catalog, which Postgres always searches first.
--   * Character classes are written out ([0-9], explicit whitespace) instead of \d / \s /
--     [[:space:]], whose meaning depends on the database's locale.
--   * All four are STRICT (NULL in, NULL out) and PARALLEL SAFE.

create extension if not exists "pgcrypto";   -- gen_random_uuid(), digests for contributor tokens
create extension if not exists "pg_trgm";    -- fuzzy name / tag matching

-- normalize_text: for search and autocomplete.
--   lowercase; Arabic letter folding (alef variants and wasla to bare alef, taa marbuta to haa,
--   alef maqsura to yaa, hamza on waw to waw, hamza on yaa to yaa); harakat U+064B-U+0652 and
--   tatweel U+0640 removed; whitespace runs collapsed to one space; trimmed.
create or replace function public.normalize_text(t text) returns text
language sql immutable strict parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(lower(t), 'أإآٱةىؤئ', 'ااااهيوي'),
        '[ً-ْـ]', '', 'g'),
      '[ \t\n\r\f\v\u00a0]+', ' ', 'g'),
    ' ')
$$;

-- normalize_phone: digits only, in E.164 (+<country><number>), default country +20 (Egypt).
--   a leading + is kept (the number already carries its country code);
--   a leading 00 is the international prefix, so it becomes +;
--   a leading 0 is the national trunk prefix, so it becomes +20 and the zero is dropped;
--   no prefix and exactly 20 + ten digits is an Egyptian number written with its country code but
--   no + (the WhatsApp / wa.me form): + is prepended;
--   no prefix and 10 or more digits is a national number without its zero: +20 is prepended;
--   no prefix and fewer than 10 digits cannot be placed in a country: returned as digits only.
-- Arabic-Indic (U+0660-0669) and Extended Arabic-Indic (U+06F0-06F9) digits are read as 0-9.
-- No digits at all (or only zeros) is not a phone number: NULL.
create or replace function public.normalize_phone(t text) returns text
language sql immutable strict parallel safe
set search_path = ''
as $$
  select case
    when d.digits ~ '^0*$' then null
    when d.has_plus then '+' || d.digits
    when d.digits like '00%' then '+' || substr(d.digits, 3)
    when d.digits like '0%' then '+20' || substr(d.digits, 2)
    when d.digits ~ '^20[0-9]{10}$' then '+' || d.digits
    when length(d.digits) >= 10 then '+20' || d.digits
    else d.digits
  end
  from (
    select
      regexp_replace(a.ascii, '[^0-9]', '', 'g') as digits,
      -- the first digit-or-plus character is a plus, so "(+20) 10 ..." counts too
      a.ascii ~ '^[^0-9+]*\+' as has_plus
    from (
      select translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') as ascii
    ) a
  ) d
$$;

-- normalize_email: lowercased and trimmed (the local part is case-sensitive in theory, not in
-- practice; the spec wants exact-match duplicate detection). Blank: NULL.
create or replace function public.normalize_email(t text) returns text
language sql immutable strict parallel safe
set search_path = ''
as $$
  select nullif(
    regexp_replace(lower(t), '^[ \t\n\r\f\v\u00a0]+|[ \t\n\r\f\v\u00a0]+$', '', 'g'),
    '')
$$;

-- normalize_url: for exact-match duplicate detection of profile links.
--   lowercased as a whole (profile URLs are case-insensitive in practice); no scheme; no leading
--   www.; no query string or fragment; no trailing slash. Nothing left: NULL.
create or replace function public.normalize_url(t text) returns text
language sql immutable strict parallel safe
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(regexp_replace(t, '^[ \t\n\r\f\v\u00a0]+|[ \t\n\r\f\v\u00a0]+$', '', 'g')),
            '[?#].*$', ''),
          '^[a-z][a-z0-9+.-]*://', ''),
        '^www\.', ''),
      '/+$', ''),
    '')
$$;
