# Connections Network — Design

Date: 2026-11-19
Status: reviewed and grilled, awaiting owner approval

## 1. Intent

The owner wants a living map of everyone they know, and everyone those people
know, so that whenever a need comes up (a marketer for a software product, an
employee, a customer, a freelancer, a craftsman in a specific trade) they can
search the network and find the closest person who can meet it, along with the
chain of people who connects them.

The network grows in layers: the owner adds their contacts, and those contacts
can add theirs. Over time it becomes a comprehensive network that can answer
almost any need.

What sets it apart from LinkedIn:
- **Introductions through people you trust**, shown as an explicit path
  (Owner → Ahmed → Karim → Sara), instead of cold messages to strangers.
- **Skills of every kind**: tech, languages, sports, poetry, culture, crafts and
  trades. It also covers people who are not on LinkedIn at all.

### Phase

**Phase 1 (this design) is for the owner's personal use.** It is not a public
product. The owner is the only person who searches the network. Their contacts
contribute people as a favor to the owner; the owner does not expect them to
get any value from it yet.

A public product, where anyone can run it with their own network, is the
long-term direction. Phase 1 must not block it, but must not build for it.

## 2. Releases and success

Phase 1 ships in three releases. Each one works on its own and teaches
something before the next is built. There is no spreadsheet trial first: a
spreadsheet cannot compute paths, and paths are the core of the idea. v0.1
is the experiment.

| Release | Contents |
|---|---|
| **v0.1** | Admin (owner) adds people and connections with strength; search by skill with paths; person page; **contributor links** (no account); **exact-match duplicate warning + merge**; staleness list; delete on request; data export; Arabic/English UI. |
| **v0.2** | Fuzzy duplicate detection (`pg_trgm`, names); **needs log**; **"Need someone?" button** on the contributor-link page. |
| **v0.3** | Member accounts; claiming a profile; CSV import. |

**v0.1 success criteria**, measured one month after the owner starts using
it:
- At least 150 people in the network.
- At least 3 contributors have added at least 10 people each through their
  links.
- **Most important:** at least 3 times, the owner actually reached someone
  they needed through search and a path.

If these are met, v0.2 starts. If not, stop and understand why before building
more.

## 3. Goals, non-goals, anti-goals

### Goals
- The owner can find a person by skill, profession, industry or availability
  across the whole network and see the best path to them.
- Adding a person takes well under a minute on a phone, so contributors
  actually add more than a handful.
- One record per real person, even when several contributors add the same
  person.
- Works on phone (quick add right after meeting someone) and laptop (search,
  browse, cleanup).
- The owner can tell when data is out of date.

### Non-goals (phase 1)
- A public product, sign-ups from strangers, or monetization.
- Search for anyone other than the owner.
- In-app messaging or notifications.
- Importing friends or connections through Facebook, X or LinkedIn APIs. Those
  platforms do not allow it.
- Native iOS or Android apps (Flutter is a later option on the same API).
- An interactive whole-network graph visualization.
- **Automatic introduction suggestions** ("Ahmed needs backend, Karim is
  available for freelance"). Deferred as the clear next step after phase 1.
  The "available for" and needs-log data collected in phase 1 is what will
  power it.
- Using the needs log to influence search ranking.

### Anti-goals (failure even if it technically works)
- Contact details (phone, email) leaking to anyone other than the owner.
- Adding people is so tedious that contributors stop after five.
- The same person existing as several disconnected records, so paths through
  them are missed.
- Skills fragmenting into many spellings ("marketing", "Marketing", "digital
  mktg") so search misses people.
- Paths that lead to people who left that field years ago, with nothing
  showing the data is stale.

## 4. Constraints

- **Platform: a PWA** (owner's decision). One responsive web app, installable
  on the home screen, that works on phone and laptop.
- **Stack: a trimmed version of the ProcurePilot blueprint** (owner's
  decision). Reference:
  `/home/yasserhosny/Work/Projects/ProcurePilot/docs/architecture/tech-stack-blueprint.md`.
  See section 11 for exactly what is kept and dropped.
- **Privacy:** contact details are visible only to the admin and to whoever
  entered them. Phase 1 holds data about people who did not consent, so it
  stays a private tool. See sections 7 and 9.
- **Arabic and English.**
  - **UI:** both languages from day one. Arabic is the default, with a
    language switch, and the whole UI works right-to-left.
  - **Content:** names, skills and notes are written in both. Storage, search
    and autocomplete must handle Arabic text, with Arabic normalization within
    the script (alef/hamza forms, taa marbuta, diacritics, tatweel).
  - **No transliteration between Arabic and Latin script** (owner's
    decision). Instead, a profile has two name fields, Arabic and Latin, and
    search matches either one.
- **Online-only, with draft safety** (owner's decision). No full offline mode.
  If saving a quick add fails, the form is kept on the device and can be
  resubmitted when the connection is back.
- **Hosting cost:** the Supabase Free plan for all of v0.1 (owner's
  decision), with our own backup (section 10).

## 5. Approaches considered

### Platform
1. **PWA: one web app for phone and laptop.** ✅ Chosen.
   One codebase, fastest to a working version. The contributor link is a web
   link anyway. No app store. Trade-offs: the phone contact picker only works
   on Android Chrome (on iPhone, people are added by hand or by sharing a
   contact card), and it feels a little less native than a real app.
2. **Web app plus a native mobile app (React Native or Flutter) on a shared
   backend.** Best phone experience, with contact import on both Android and
   iPhone. Rejected for now: roughly double the work, and distributing a native
   app to contributors (TestFlight or an APK) adds friction for people who get
   nothing from it. It stays open as a later step on the same API.
3. **Off-the-shelf tools** (Notion, Airtable, or personal CRMs like Clay or
   Dex). Rejected: none of them does multi-hop path search, which is the core
   of the idea, and none lets contacts add their own contacts into a shared
   network.

### Stack
1. **Trimmed ProcurePilot blueprint** (FastAPI + Angular 22 + Supabase +
   bunny.net). ✅ Chosen. The owner already knows these tools and patterns.
   Several of them fit this project directly: invite-only Supabase Auth with
   MFA, forced RLS, `pg_trgm`, and `packages/i18n` with RTL.
2. **Next.js + Supabase on Vercel.** It would have fewer moving parts, but it
   is new to the owner and has no existing patterns to reuse. Rejected.

## 6. Core concepts

- **Network:** the set of all data. Phase 1 has exactly one, the owner's.
  Every table carries `network_id` from day one (see 11.3).
- **Person:** a profile of one real human. It may or may not have an account.
  The owner is also a Person.
- **Connection:** an undirected link between two Persons who know each other.
  It has a **strength**, an optional note on how they know each other, and a
  record of who created it.
  - **What counts as knowing someone:** anyone you could send a message to who
    would know who you are. People you only met once are added as *weak*. The
    add form shows this definition so every contributor uses the same scale.
  - Strength levels: strong / normal / weak.
- **Account:** login credentials tied to exactly one Person (v0.3 for Members;
  the admin has one from v0.1).
- **Contributor link:** a personal, revocable, expiring link the admin
  generates for a Person. It lets that Person add people without an account.
- **Claimed / unclaimed:** a Person is *claimed* once their own account is
  attached to the record. Until then it is *unclaimed*, meaning others wrote
  the data about them.
- **Need (v0.2):** a record of something someone was looking for, and how it
  was resolved.

## 7. Profile

Each Person has:

- Name: an Arabic-script field and a Latin-script field (fill either or
  both), optional photo
- Headline / current job title, organization
- Profession (free text with autocomplete, for example "Developer", "Plumber",
  "Marketing")
- **Skills:** free-text tags with autocomplete from tags already used.
  - Each tag belongs to one category:
    - Technical (e.g. .NET, Java, Python, backend, frontend)
    - Languages (e.g. English, French)
    - Sports
    - Arts and literature (e.g. poetry)
    - Culture
    - Crafts and trades
    - Business (e.g. marketing, sales)
    - Other
  - Each skill on a person has an **optional level**: basic / good / expert.
    It is never required, to keep adding fast.
- **Industry** (optional): free-text tags with autocomplete, handled like
  skills (e.g. banking, education, healthcare, construction).
- **Seniority** (optional): employee / manager / decision-maker / business
  owner. Together with industry, this lets the owner find *customers*, not only
  service providers: "decision-maker in banking".
- **Available for** (optional, multi-select): looking for a job / takes
  freelance work / offers a service or product / looking for a partner.
- Social links: Facebook, X, LinkedIn, Instagram, GitHub, website (any subset)
- Contact details: phone, WhatsApp, email. Visible only as described in 7.2.
- City / country
- Private notes, admin-only
- **Last confirmed** date: set when the profile is created, and reset whenever
  someone edits or explicitly confirms it.

Skill and industry tags are normalized so variants merge into one:
case-insensitive, and the admin can mark a tag as an alias of another (e.g.
"mktg" → "marketing"). Autocomplete steers people toward existing tags.

### 7.1 Roles and visibility

| | Admin (owner) | Member (account, v0.3) | Link contributor (no account) |
|---|---|---|---|
| Search the whole network, see paths | ✅ | ❌ | ❌ |
| See contact details | ✅ everyone, claimed or not | Only values they entered | ❌ |
| Add people and connections | ✅ anywhere | ✅ from themselves | ✅ from themselves |
| Edit | ✅ everything | Own profile + people they added | ❌ after submission |
| Merge duplicates, manage tags, manage links | ✅ | ❌ | ❌ |

- Roles are real from day one, even though the owner is the only admin and
  Members arrive in v0.3. Opening the product later then means adding roles,
  not rebuilding access control.
- A Member does not see other contributors' people. If Member X could see Y's
  contacts, contact data would leak to people its subjects never agreed to.
- A Member can always see and edit their own Person's profile once they claim
  it.

### 7.2 Who supplied what (provenance)
- Profile fields (name, job, profession, skills, industry, seniority,
  availability, social links, city) live on one shared record per Person. They
  are not sensitive, so any contributor who added that Person sees the merged
  values.
- **Contact details are stored as separate values, and each one records who
  entered it** (Person, type, value, added_by). A Member sees only the contact
  values they entered themselves. The admin sees all of them. After a merge,
  Member X still sees the phone X entered but not the email Y entered.
- Each Connection records who created it. A Member sees and edits only the
  connections they created.
- **When a Person claims their profile, they own it.** They see every value
  stored about them, including contact details and connections others
  entered, and they can edit or delete any of it. The admin still sees
  whatever remains.

## 8. Key flows

### 8.1 Quick add (phone) — v0.1
The admin opens "Add person". The required fields are name and connection
strength. Everything else is optional on the same screen. Saving creates the
Person and a Connection between the adder and the new Person. On Android,
"Pick from contacts" fills in name, phone and email through the Contact Picker
API. (Members get the same flow in v0.3.)

### 8.2 Contributor link (no account) — v0.1
The admin generates a link for Person X and sends it to X (for example over
WhatsApp). X opens it on their phone and sees a short Arabic-first form that
adds people one after another. Each submitted person is connected to X.

- Submissions go live immediately and are marked "added via link by X". The
  admin can edit or delete them. *(Live without review is Claude's call: the
  contributors are a trusted circle, and a review queue adds work for the
  owner.)*
- Links expire after **30 days** and can be renewed with one click. The admin
  can revoke a link at any time.
- After submitting, X can see what they added in that session only.
- Security design: see 11.4.
- **v0.2 adds a "Need someone?" button** to this page. X writes a need; it goes
  to the owner, who searches the network and connects X. X never sees the
  network, so privacy is unchanged, but X now has a reason to add people.

### 8.3 Adding on someone's behalf — v0.1
The admin can add a person and connect them to any existing Person, not just
the admin. This covers "X told me about his contacts, I'll enter them".

### 8.4 Duplicate detection and merge
- **v0.1, exact match:** when a person is added, the system warns when the
  phone, email or a social link URL matches an existing Person exactly (after
  normalizing: phone digits and country code, lowercase email, canonical URL).
  These signals work across scripts. The admin sees a review list and merges
  or dismisses.
- **v0.2, fuzzy match:** similar names in the same script (`pg_trgm`), plus the
  same city or profession, are flagged as weaker candidates in the same list.
- **Merge:** keeps every connection from both records and keeps the more
  complete value field by field. Contact values keep their provenance (7.2).
  The admin can override any field.

### 8.5 Inviting a Person to claim their profile — v0.3
The admin invites an existing Person to create an account. The account
attaches to that existing record, never to a new one. The Person can then
edit their profile and add their own people.

### 8.6 Search (admin) — v0.1
The admin searches by skill, profession, industry or free text. Filters:
skill category, skill level, industry, seniority, available for, city. Each
result shows:

```
Sara Mahmoud · Digital Marketing · SEO (expert), Meta Ads · Cairo
Available for: freelance · Last confirmed: 3 months ago
You ← Ahmed ← Karim ← Sara      (3 steps)
[Ask Ahmed for an intro]   [Contact directly]
```

- **Ranking:** results are ordered by path cost from the owner. Strong = 1,
  normal = 2, weak = 3, and lower total cost comes first. A short path through
  weak ties can rank below a longer path through strong ones. When path costs
  are close, a higher skill level ranks higher. *(Weights are Claude's call;
  the owner can tune them.)* Search covers all hops: the network is all the
  owner's, so there is no depth cut-off.
- **Stale data:** profiles not confirmed in over 12 months are visibly marked
  in results.
- **Alternative paths:** a result can expand to show the next-best paths to the
  same person.
- **"Ask for an intro"** opens a prefilled message to the first person in the
  path, through WhatsApp or as copyable text. Example: "Hi Ahmed, do you know
  someone who can introduce me to Sara Mahmoud (marketing)? Karim knows her."
  There is no in-app messaging.
- **"Contact directly"** shows the target's contact details.

### 8.7 Person page — v0.1
Shows the profile, that Person's connections (one hop, with strength), and the
path from the owner. From here the admin can navigate person to person through
the network.

### 8.8 Staleness review — v0.1
An admin list shows every Person whose *last confirmed* date is more than 12
months old. From it, the admin can confirm, edit, or generate a contributor
link for someone to update the profile. The list is computed when viewed; no
background job is needed. *(Putting this in v0.1 is Claude's call: it is one
query.)*

### 8.9 Needs log — v0.2
Each need records: who asked (the owner, or a contributor through "Need
someone?"), the need itself, a status (open / in progress / resolved /
not resolved), and the people suggested for it. It is a plain log. It does not
affect search ranking in phase 1.

### 8.10 Bulk import (admin) — v0.3
- CSV import with column mapping. It covers the LinkedIn "Connections" export
  that users download themselves, and Google Contacts CSV.
- Imported people connect to a chosen Person (by default the admin), with a
  chosen default strength.
- Imported records go through duplicate detection (8.4).
- Kept out of v0.1 on purpose: an import brings in hundreds of names with no
  skills. Search works by skills, so they would only add noise.

## 9. Privacy and data handling

- Contact details are visible only as described in 7.2.
- The app is private: no public pages, nothing indexed, no sign-up without an
  invite.
- The admin can fully delete a Person on request. Deleting removes the
  Person's connections and their data in all records.
  - People who were reachable only through the deleted Person are **kept**,
    but flagged "not connected to you" in an admin list so the admin can
    reconnect them. Nothing cascades.
  - If the deleted Person was a contributor, the people they added stay. Only
    the connections to the deleted Person go away, and the orphan rule above
    applies.
  - There is no suppression list in phase 1. If someone re-adds a deleted
    Person, the admin deletes them again. This avoids keeping a hidden store
    of data about someone who asked to be removed.
- The admin can export all data (CSV/JSON) at any time.
- Before any public phase, consent and legal compliance must be redesigned.
  This covers Egypt's Personal Data Protection Law (151/2020), and GDPR if
  there are EU users. Phase 1 deliberately does not solve this.

## 10. Security and backups

- **Admin MFA:** TOTP via Supabase Auth, required on the admin account.
- **Invite-only sign-up** via Supabase Auth.
- **Contributor links** expire after 30 days, are revocable, and are rate
  limited (11.4).
- **No contact details in URLs or logs.** Request logging must redact them.
- **Backups (Supabase Free plan, all of v0.1):** the Free plan has no backups
  and pauses a project after 7 days without activity. So:
  - A scheduled **GitHub Action runs every night**. It takes a `pg_dump`,
    encrypts it, and uploads it to **bunny.net Storage**.
  - The same job sends a request to the API so the project does not pause.
  - A restore procedure is documented and tried once before the first
    contributor link is sent.
  - Moving to Supabase Pro is reconsidered when v0.2 starts.

## 11. Stack

Based on the ProcurePilot blueprint, trimmed for a personal tool. Where this
section is silent, follow the blueprint's conventions.

### 11.1 Kept
- **Monorepo:** pnpm + Turborepo, with `apps/api`, `apps/web`,
  `packages/i18n` (en.json + ar.json) and `packages/domain-types`.
- **Backend:** FastAPI modular monolith on Python 3.12, with Pydantic v2,
  psycopg v3 through a single `connect()`, uv, ruff, pytest, and the
  `/api/v1` conventions (error envelope, cursor pagination,
  `Idempotency-Key`). SlowAPI for rate limiting.
- **Frontend:** Angular 22, standalone components and signals, strict
  TypeScript, Angular Material, `@ngx-translate`, CSS logical properties
  only. It becomes a PWA with `@angular/service-worker`.
- **Data:** hosted Supabase (Postgres 17 + Auth + Storage), forward-only SQL
  migrations applied by the Supabase CLI, and local development with
  `supabase start`.
  - Extensions: `pgcrypto` and `pg_trgm`. `pg_trgm` is used for autocomplete in
    v0.1 and fuzzy duplicate matching in v0.2.
  - Path finding uses recursive SQL queries. That is enough at personal scale
    (thousands of people). No graph database.
- **Deploy:** GitHub Actions → GHCR → bunny.net, with the API and web
  containers in one app behind Nginx, as in the blueprint.
- **CI (trimmed `ci.yml`):** lint (including the i18n key check), backend
  tests on a real Postgres, an RLS / visibility test job, and gitleaks.

### 11.2 Dropped for now
Redis/RQ and all workers, Flutter, Terraform, AI/evals, the docs-screenshot
gate, and per-service deploy workflows. Any later periodic work uses a simple
interval loop, as in the blueprint.

### 11.3 Network scoping
Every table carries `network_id`, stamped into the JWT by a custom access-token
hook. RLS policies use it, following the blueprint's `tenant_id` pattern
(`ENABLE` + `FORCE`, `USING` + `WITH CHECK`). Phase 1 has exactly one network.
This costs little now. Adding it later would mean rewriting every RLS policy
over real data.

On top of network scoping, RLS also enforces the visibility rules in 7.1 and
7.2. A Member's queries return only their own contact values and connections.
Even a bug in the API cannot leak contact data.

### 11.4 Contributor-link security
Link contributors have no Supabase session and no JWT, so RLS cannot identify
them. So:
- The link carries a random token. Only its hash is stored, together with the
  Person it belongs to, its expiry and its revoked flag.
- FastAPI validates the token on every request.
- Writes go through a narrow **`SECURITY DEFINER` function that can only
  insert**: a new Person, their contact values, and a Connection to the link's
  owner. It cannot read anything, so the session read-back in 8.2 comes only
  from what was just inserted under that token.
- The endpoint is rate limited with SlowAPI.
- The exception is recorded as an **ADR**, following the blueprint's
  "narrow, documented exception" pattern.
- `service_role` is never used on this request path.

## 12. Decided vs. left to the builder

**Decided by the owner:**
- Phase 1 is personal use only; the owner is the admin and only searcher.
- Contacts can have accounts and add their own contacts (v0.3), and can
  contribute through links without an account (v0.1).
- The admin sees contact details even for unclaimed profiles.
- Profiles hold mostly public, work-related information plus skills of all
  kinds and social links.
- Search shows the path and skills; the owner can ask for an introduction or
  make contact directly.
- Usage on both phone and laptop; platform is a PWA.
- Two name fields (Arabic / Latin), no cross-script transliteration.
- No full offline mode; failed quick adds are kept as drafts on the device.
- Release split, contents and v0.1 success criteria (section 2).
- Definition of a connection; skill levels; industry, seniority and
  "available for"; last-confirmed date with a 12-month threshold.
- Needs log and "Need someone?" in v0.2; CSV import in v0.3; automatic intro
  suggestions deferred.
- Arabic and English UI from day one, Arabic default, RTL.
- Trimmed ProcurePilot stack (section 11), including `network_id` from day
  one and the contributor-link security design.
- Supabase Free plan for all of v0.1 with a nightly encrypted backup to
  bunny.net Storage.
- Security baseline in section 10.

**Claude's calls (owner can override):**
- Roles built from day one; Members don't see others' contributions.
- Submissions through links go live without review.
- Free skill and industry tags with categories, autocomplete and aliases.
- Connection strength path weights, and skill level as a tie-breaker.
- Intro requests as prefilled WhatsApp/text messages.
- Contact values carry who entered them; a claimed Person owns everything
  about them (7.2).
- Deletion keeps orphaned people and flags them; no suppression list (9).
- Staleness review list in v0.1 (8.8).
- Needs log fields and statuses (8.9).

**Left to the builder:**
- Exact screen layouts, within: mobile-first quick add, laptop-friendly
  search, Arabic-first contributor form.
- Exact normalization rules for phones, emails and URLs, and fuzzy-match
  thresholds in v0.2.
- Storage of photos (Supabase Storage, private buckets, as in the blueprint).
- Encryption method and key handling for backups, within: the key never lives
  in the repo.
