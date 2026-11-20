-- upsert_tag: the single rule for turning a typed tag label into a tag id (spec 7).
--
-- Shared by the people API (Task 6) and the contributor-link submit function (Task 10):
--   * matches on normalize_text(label) within (network, kind), so "Marketing", " marketing " and
--     Arabic spelling variants merge into one tag;
--   * follows an alias to its target, so "mktg" stored as an alias of "marketing" answers with
--     the marketing tag (the chain is followed, bounded, because an alias of an alias is not
--     ruled out by the schema);
--   * inserts a new tag when nothing matches. A match keeps the tag's ORIGINAL label and
--     category: whoever types a variant later does not rename or re-categorise it.
--
-- The network is passed explicitly rather than read from the JWT claims: Task 10 calls this
-- from a SECURITY DEFINER function running for `anon`, which has no network claim, with the
-- network of the contributor link it has just verified.
--
-- SECURITY INVOKER, so the caller's row-level security still applies: an admin passing another
-- network's id sees no tags there and fails the insert's WITH CHECK. The category rules are the
-- schema's (tag_category_iff_skill): required for a skill, absent for an industry; a violation
-- raises check_violation.
--
-- search_path is pinned empty (every name below is schema-qualified) so a caller cannot shadow
-- normalize_text or the tag table.

create or replace function public.upsert_tag(
  p_network_id uuid,
  p_kind       public.tag_kind,
  p_label      text,
  p_category   public.skill_category
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_norm  text := public.normalize_text(p_label);
  v_id    uuid;
  v_alias uuid;
  v_next  uuid;
  v_hops  int := 0;
begin
  select t.id, t.alias_of_tag_id into v_id, v_alias
  from public.tag t
  where t.network_id = p_network_id and t.kind = p_kind and t.label_norm = v_norm;

  if not found then
    insert into public.tag (network_id, kind, category, label)
    values (p_network_id, p_kind, p_category, btrim(p_label))
    on conflict on constraint tag_label_unique do nothing
    returning id, alias_of_tag_id into v_id, v_alias;

    if not found then
      -- A concurrent transaction inserted the same label first: use its row.
      select t.id, t.alias_of_tag_id into v_id, v_alias
      from public.tag t
      where t.network_id = p_network_id and t.kind = p_kind and t.label_norm = v_norm;
    end if;
  end if;

  while v_alias is not null and v_hops < 8 loop
    select t.id, t.alias_of_tag_id into v_next, v_alias
    from public.tag t
    where t.network_id = p_network_id and t.id = v_alias;
    exit when v_next is null;  -- the target is not visible to the caller: keep the last tag
    v_id := v_next;
    v_hops := v_hops + 1;
  end loop;

  return v_id;
end
$$;

comment on function public.upsert_tag(uuid, public.tag_kind, text, public.skill_category) is
  'Tag id for a typed label: match on normalized label, resolve an alias, else insert. Invoker rights.';

-- Same grants as the tables: signed-in callers only. anon reaches tags solely through Task 10's
-- definer function, which owns the call.
revoke all on function public.upsert_tag(uuid, public.tag_kind, text, public.skill_category) from public;
grant execute on function public.upsert_tag(uuid, public.tag_kind, text, public.skill_category) to authenticated;
