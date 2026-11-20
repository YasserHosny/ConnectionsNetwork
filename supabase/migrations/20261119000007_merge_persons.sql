-- merge_persons: fold a duplicate person (p_drop) into the one to keep (p_keep), then delete it
-- (spec 8.4). One transaction: any error undoes the whole merge.
--
-- Who may call it, and on what:
--   * SECURITY INVOKER, so row-level security applies to every statement below: the caller can
--     only reach rows of their own network. On top of that the function raises unless the
--     caller's role claim is 'admin' (members and `anon` are refused outright).
--   * Both people must be visible to the caller and different. Anything else raises, and nothing
--     has been changed by then.
--   * A person with an account (a `member` row) cannot be the one dropped: deleting it would
--     delete the account. It can be the one kept.
--
-- Errors, each with its own SQLSTATE so the API can map them without parsing text:
--   42501 insufficient_privilege              not an admin
--   22023 invalid_parameter_value             keep and drop are the same person
--   P0002 no_data_found                       a person is not visible (hint: 'keep' | 'drop')
--   55000 object_not_in_prerequisite_state    the dropped person has an account
--
-- What happens to the dropped person's references (every one is handled before the final delete,
-- so deleting the person cascades nothing the admin would miss):
--   * contact values: move to keep, provenance (added_by) unchanged. An exact repeat, the same
--     (kind, normalized value) from the same added_by, is dropped. The same value from somebody
--     else stays: each contributor keeps seeing the value they entered (spec 7.2). Values the
--     dropped person entered themselves become the kept person's own.
--   * social links: move, one per normalized URL.
--   * skills: union; where both have the skill the higher level wins (an unset level loses).
--   * industries: union.
--   * connections: the keep-drop edge is deleted (no self-loop). An edge drop-N becomes keep-N,
--     with the pair stored in order (person_a < person_b); where keep-N exists already, one edge
--     remains with the stronger strength and keep's own note when it has one. The connections
--     the dropped person created are attributed to keep.
--   * contributor links move to keep: a link already handed out keeps working, for keep.
--   * idempotency keys that created drop answer with keep.
--   * people the dropped person created are attributed to keep (unless that is keep itself:
--     nobody is the creator of themselves, the reference is cleared instead).
--   * dismissed pairs move to keep, minus the pair of the two themselves and minus repeats.
--   * profile fields: an empty value on keep (null, or blank text) is filled from drop; a
--     non-empty value on keep wins. available_for is the union, last_confirmed_at the greater.
--     Provenance of the record itself (created_by, created_via, contributor_link_id,
--     created_at) stays keep's.
--
-- search_path is pinned empty (every name below is schema-qualified), so a caller cannot shadow
-- a function or table.

create or replace function public.merge_persons(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_drop public.person;
begin
  if (select public.current_member_role()) is distinct from 'admin' then
    raise exception 'merging people requires the admin role'
      using errcode = '42501';
  end if;

  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'keep and drop must be two different people'
      using errcode = '22023';
  end if;

  -- Lock both rows, in id order so two merges over the same pair cannot deadlock. RLS hides a
  -- person of another network, which is reported like a missing one.
  perform 1 from public.person where id in (p_keep, p_drop) order by id for update;

  perform 1 from public.person where id = p_keep;
  if not found then
    raise exception 'the person to keep was not found' using errcode = 'P0002', hint = 'keep';
  end if;
  select * into v_drop from public.person where id = p_drop;
  if not found then
    raise exception 'the person to drop was not found' using errcode = 'P0002', hint = 'drop';
  end if;

  if exists (select 1 from public.member m where m.person_id = p_drop) then
    raise exception 'the person to drop has an account' using errcode = '55000';
  end if;

  -- Provenance first, so every later comparison sees the final authorship.
  update public.contact_value set added_by_person_id = p_keep where added_by_person_id = p_drop;
  update public.connection set created_by_person_id = p_keep where created_by_person_id = p_drop;
  update public.person set created_by_person_id = p_keep
    where created_by_person_id = p_drop and id <> p_keep;

  -- Profile fields: keep's non-empty value wins, an empty one is filled from drop.
  update public.person k set
    name_ar      = case when nullif(btrim(k.name_ar), '') is not null then k.name_ar
                        when nullif(btrim(v_drop.name_ar), '') is not null then v_drop.name_ar
                        else k.name_ar end,
    name_latin   = case when nullif(btrim(k.name_latin), '') is not null then k.name_latin
                        when nullif(btrim(v_drop.name_latin), '') is not null then v_drop.name_latin
                        else k.name_latin end,
    headline     = case when nullif(btrim(k.headline), '') is not null then k.headline
                        when nullif(btrim(v_drop.headline), '') is not null then v_drop.headline
                        else k.headline end,
    organization = case when nullif(btrim(k.organization), '') is not null then k.organization
                        when nullif(btrim(v_drop.organization), '') is not null then v_drop.organization
                        else k.organization end,
    profession   = case when nullif(btrim(k.profession), '') is not null then k.profession
                        when nullif(btrim(v_drop.profession), '') is not null then v_drop.profession
                        else k.profession end,
    city         = case when nullif(btrim(k.city), '') is not null then k.city
                        when nullif(btrim(v_drop.city), '') is not null then v_drop.city
                        else k.city end,
    country      = case when nullif(btrim(k.country), '') is not null then k.country
                        when nullif(btrim(v_drop.country), '') is not null then v_drop.country
                        else k.country end,
    admin_notes  = case when nullif(btrim(k.admin_notes), '') is not null then k.admin_notes
                        when nullif(btrim(v_drop.admin_notes), '') is not null then v_drop.admin_notes
                        else k.admin_notes end,
    photo_path   = case when nullif(btrim(k.photo_path), '') is not null then k.photo_path
                        when nullif(btrim(v_drop.photo_path), '') is not null then v_drop.photo_path
                        else k.photo_path end,
    seniority    = coalesce(k.seniority, v_drop.seniority),
    available_for = array(
                      select distinct a from unnest(k.available_for || v_drop.available_for) a
                      order by a),
    last_confirmed_at = greatest(k.last_confirmed_at, v_drop.last_confirmed_at)
  where k.id = p_keep;

  -- Contact values: drop the exact repeats (same kind, same normalized value, same added_by,
  -- whether against keep's rows or among drop's own), then move the rest.
  delete from public.contact_value cv
  where cv.person_id = p_drop
    and exists (
      select 1 from public.contact_value o
      where o.kind = cv.kind
        and coalesce(o.value_norm, o.value) = coalesce(cv.value_norm, cv.value)
        and o.added_by_person_id is not distinct from cv.added_by_person_id
        and o.id <> cv.id
        and (o.person_id = p_keep or (o.person_id = p_drop and o.id < cv.id))
    );
  update public.contact_value set person_id = p_keep where person_id = p_drop;

  -- Social links: one per normalized URL.
  delete from public.social_link sl
  where sl.person_id = p_drop
    and exists (
      select 1 from public.social_link o
      where coalesce(o.url_norm, o.url) = coalesce(sl.url_norm, sl.url)
        and o.id <> sl.id
        and (o.person_id = p_keep or (o.person_id = p_drop and o.id < sl.id))
    );
  update public.social_link set person_id = p_keep where person_id = p_drop;

  -- Skills: union, the higher level wins (greatest ignores an unset level). Industries: union.
  insert into public.person_skill as ps (network_id, person_id, tag_id, level)
  select s.network_id, p_keep, s.tag_id, s.level
  from public.person_skill s where s.person_id = p_drop
  on conflict (person_id, tag_id) do update set level = greatest(ps.level, excluded.level);
  delete from public.person_skill where person_id = p_drop;

  insert into public.person_industry (network_id, person_id, tag_id)
  select i.network_id, p_keep, i.tag_id from public.person_industry i where i.person_id = p_drop
  on conflict (person_id, tag_id) do nothing;
  delete from public.person_industry where person_id = p_drop;

  -- Connections. The edge between the two would become a self-loop: delete it.
  delete from public.connection
  where person_a = least(p_keep, p_drop) and person_b = greatest(p_keep, p_drop);

  -- Where keep and drop are both connected to N, keep the stronger strength (the enum is ordered
  -- strongest first, so least() is the stronger) and keep's note, else drop's.
  update public.connection k set
    strength = least(k.strength, d.strength),
    note     = case when nullif(btrim(k.note), '') is not null then k.note
                    when nullif(btrim(d.note), '') is not null then d.note
                    else k.note end
  from (
    select case when person_a = p_drop then person_b else person_a end as other,
           strength, note
    from public.connection where p_drop in (person_a, person_b)
  ) d
  where k.person_a = least(p_keep, d.other) and k.person_b = greatest(p_keep, d.other);

  delete from public.connection d
  where p_drop in (d.person_a, d.person_b)
    and exists (
      select 1 from public.connection k
      where k.person_a = least(p_keep, case when d.person_a = p_drop then d.person_b else d.person_a end)
        and k.person_b = greatest(p_keep, case when d.person_a = p_drop then d.person_b else d.person_a end)
    );

  -- The rest become keep's, stored in order. The right-hand side reads the old row.
  update public.connection set
    person_a = least(p_keep, case when person_a = p_drop then person_b else person_a end),
    person_b = greatest(p_keep, case when person_a = p_drop then person_b else person_a end)
  where p_drop in (person_a, person_b);

  update public.contributor_link set person_id = p_keep where person_id = p_drop;

  -- A retried create request (Idempotency-Key) that made drop now answers with keep.
  update public.idempotency_key set person_id = p_keep where person_id = p_drop;

  -- Dismissed pairs involving drop become keep's, except the pair of the two themselves.
  insert into public.duplicate_dismissal (network_id, person_a, person_b)
  select network_id, least(p_keep, other), greatest(p_keep, other)
  from (
    select network_id, case when person_a = p_drop then person_b else person_a end as other
    from public.duplicate_dismissal where p_drop in (person_a, person_b)
  ) d
  where other <> p_keep
  on conflict (person_a, person_b) do nothing;
  delete from public.duplicate_dismissal where p_drop in (person_a, person_b);

  delete from public.person where id = p_drop;
end
$$;

comment on function public.merge_persons(uuid, uuid) is
  'Fold person p_drop into p_keep and delete it. Admin only, invoker rights; see the file header.';

-- Signed-in callers only; the admin check is inside. anon never merges.
revoke all on function public.merge_persons(uuid, uuid) from public, anon;
grant execute on function public.merge_persons(uuid, uuid) to authenticated;
