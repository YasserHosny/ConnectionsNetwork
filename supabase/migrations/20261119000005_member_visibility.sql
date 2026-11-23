-- Member visibility (spec 7.1, 7.2): what a `member` role may see and write, on top of the
-- admin policies of 20261119000003_rls.sql. Members arrive in v0.3; the policies exist from
-- day one so opening the product later adds accounts, not access control.
--
-- A member sees:
--   * their own person, and the people they created (a member never sees other contributors'
--     people: that would leak contact data to people its subjects never agreed to);
--   * the contact values they entered themselves, and EVERY value on their own person once
--     they have claimed it (7.2: the owner of a profile owns what is stored about them);
--   * the connections they created;
--   * the skills, industries and social links of the people they can see;
--   * every tag in the network (to pick from), and may add new ones.
--
-- Everything else is denied, and so is every table not listed here (member, contributor_link,
-- duplicate_dismissal, network): the admin policy is the only one that matches on those.
--
-- Mechanics, the same as the admin policies:
--   * Policies are PERMISSIVE and OR together, so the admin policy is untouched. A member's
--     token fails the admin policy (role <> 'admin') and an admin's token fails these.
--   * Each policy is `to authenticated`, gated on role = 'member' AND network_id = the caller's
--     network. Claims come from the verified JWT only. NULL claims deny.
--   * Every command that writes carries WITH CHECK, so a member cannot WRITE a row they could
--     not read. Where a policy is `for all`, USING is also the check unless given separately.
--   * Accessors are wrapped in (select ...) so Postgres evaluates them once per statement.
--
-- Not enforceable here (observations for the API layer): RLS works on rows, not columns. A
-- member who can update their own person can also write person.admin_notes, created_via and
-- contributor_link_id on it, and can read admin_notes (spec: "private notes, admin-only").

-- ---------------------------------------------------------------------------
-- person: own person and the people the member created.
-- No delete: removing a person is not granted to members (not in spec 7.1's member column).
-- Insert requires created_by = self, so every person a member adds is theirs and visible to
-- them; update's check stops re-attributing a person to somebody else (that would hand it over
-- to another member, or orphan it from its creator).
-- ---------------------------------------------------------------------------
create policy person_member_select on public.person
  for select
  to authenticated
  using (network_id = (select public.current_network_id())
         and (select public.current_member_role()) = 'member'
         and (id = (select public.current_person_id())
              or created_by_person_id = (select public.current_person_id())));

create policy person_member_insert on public.person
  for insert
  to authenticated
  with check (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and created_by_person_id = (select public.current_person_id()));

create policy person_member_update on public.person
  for update
  to authenticated
  using      (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and (id = (select public.current_person_id())
                   or created_by_person_id = (select public.current_person_id())))
  with check (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and (id = (select public.current_person_id())
                   or created_by_person_id = (select public.current_person_id())));

-- ---------------------------------------------------------------------------
-- contact_value: visibility is per VALUE (spec 7.2), not per person.
--
-- A member reaches the values they entered, and every value on their own person (the claimed
-- profile). The same predicate is the write check, with one consequence worth stating: a member
-- cannot write added_by = somebody else on a person that is not theirs (no forging provenance
-- to plant a value in another member's view), but on their OWN profile they may, because 7.2
-- lets the owner edit and delete values others entered, and an update that merely keeps the
-- original added_by must still pass. Forging added_by there only exposes the owner's own data to
-- the member they name, which the owner chose to do.
-- ---------------------------------------------------------------------------
create policy contact_value_member on public.contact_value
  for all
  to authenticated
  using      (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and (added_by_person_id = (select public.current_person_id())
                   or person_id = (select public.current_person_id())))
  with check (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and (added_by_person_id = (select public.current_person_id())
                   or person_id = (select public.current_person_id())));

-- ---------------------------------------------------------------------------
-- connection: only the ones the member created (spec 7.2). The check also keeps a member from
-- creating an edge under somebody else's name.
-- ---------------------------------------------------------------------------
create policy connection_member on public.connection
  for all
  to authenticated
  using      (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and created_by_person_id = (select public.current_person_id()))
  with check (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member'
              and created_by_person_id = (select public.current_person_id()));

-- ---------------------------------------------------------------------------
-- person_skill, person_industry, social_link: profile fields follow the person. The EXISTS
-- reads `person` as the member, so person's own policies apply inside it: the child row is
-- reachable exactly when its person is. The composite foreign key already ties the row's
-- network_id to its person's, but the network is checked here too for the same fail-closed
-- reason as everywhere else.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['person_skill', 'person_industry', 'social_link'] loop
    execute format(
      'create policy %I on public.%I for all to authenticated'
      '  using      (network_id = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''member'''
      '              and exists (select 1 from public.person p where p.id = %I.person_id))'
      '  with check (network_id = (select public.current_network_id())'
      '              and (select public.current_member_role()) = ''member'''
      '              and exists (select 1 from public.person p where p.id = %I.person_id))',
      t || '_member', t, t, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- tag: the shared vocabulary. A member reads the whole network's tags and may add one; renaming,
-- aliasing and deleting stay with the admin (no update or delete policy).
-- ---------------------------------------------------------------------------
create policy tag_member_select on public.tag
  for select
  to authenticated
  using (network_id = (select public.current_network_id())
         and (select public.current_member_role()) = 'member');

create policy tag_member_insert on public.tag
  for insert
  to authenticated
  with check (network_id = (select public.current_network_id())
              and (select public.current_member_role()) = 'member');
