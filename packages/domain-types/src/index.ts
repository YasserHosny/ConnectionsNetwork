/**
 * TypeScript mirrors of the API's request and response schemas (apps/api/src/connections_api/
 * modules/<name>/schemas.py), field names exactly as the API sends them.
 *
 * Wire conventions: UUIDs and timestamps travel as strings (ISO 8601 for timestamps), optional
 * values as `null`. Request types mark a field optional (`?`) where the API gives it a default.
 * When a schema changes in the API, change it here in the same commit.
 */

export type Uuid = string;
export type IsoDateTime = string;

// -- value sets (global constraints; also the database enums) -----------------------------------

export const STRENGTHS = ['strong', 'normal', 'weak'] as const;
export type Strength = (typeof STRENGTHS)[number];

export const SKILL_LEVELS = ['basic', 'good', 'expert'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const SKILL_CATEGORIES = [
  'technical',
  'languages',
  'sports',
  'arts_literature',
  'culture',
  'crafts_trades',
  'business',
  'other',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const SENIORITIES = ['employee', 'manager', 'decision_maker', 'business_owner'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const AVAILABLE_FOR = [
  'job_seeking',
  'freelance',
  'offers_service',
  'partner_seeking',
] as const;
export type AvailableFor = (typeof AVAILABLE_FOR)[number];

export const SOCIAL_LINK_KINDS = [
  'facebook',
  'x',
  'linkedin',
  'instagram',
  'github',
  'website',
] as const;
export type SocialLinkKind = (typeof SOCIAL_LINK_KINDS)[number];

export const CONTACT_KINDS = ['phone', 'whatsapp', 'email'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const TAG_KINDS = ['skill', 'industry'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const EXPORT_FORMATS = ['json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// -- errors -------------------------------------------------------------------------------------

/** The body of every non-2xx response (errors.py `ErrorEnvelope`). */
export interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown> | Record<string, unknown>[] | null;
  trace_id: string;
}

// -- people -------------------------------------------------------------------------------------

export interface SkillInput {
  label: string;
  category: SkillCategory;
  level?: SkillLevel | null;
}

export interface SocialLinkInput {
  kind: SocialLinkKind;
  url: string;
}

export interface ContactInput {
  kind: ContactKind;
  value: string;
}

/** `name_ar` or `name_latin` is required; the API answers 422 when both are missing. */
export interface PersonInput {
  name_ar?: string | null;
  name_latin?: string | null;
  headline?: string | null;
  organization?: string | null;
  profession?: string | null;
  seniority?: Seniority | null;
  available_for?: AvailableFor[];
  city?: string | null;
  country?: string | null;
  admin_notes?: string | null;
  skills?: SkillInput[];
  industries?: string[];
  social_links?: SocialLinkInput[];
  contacts?: ContactInput[];
}

export interface NewPersonRequest {
  person: PersonInput;
  connect_to_person_id: Uuid;
  strength: Strength;
  connection_note?: string | null;
}

export interface ConnectionIn {
  person_a: Uuid;
  person_b: Uuid;
  strength: Strength;
  note?: string | null;
}

/** Fields left out stay as they are; `note: null` clears the note; `strength` is never null. */
export interface ConnectionPatch {
  strength?: Strength;
  note?: string | null;
}

export interface ConnectionRecord {
  id: Uuid;
  person_a: Uuid;
  person_b: Uuid;
  strength: Strength;
  note: string | null;
  created_by_person_id: Uuid | null;
  created_at: IsoDateTime;
}

/** A connection as seen from one person: who is at the other end. */
export interface ConnectionOut {
  id: Uuid;
  person_id: Uuid;
  display_name: string;
  strength: Strength;
  note: string | null;
}

export interface SkillOut {
  tag_id: Uuid;
  label: string;
  category: SkillCategory;
  level: SkillLevel | null;
}

export interface IndustryOut {
  tag_id: Uuid;
  label: string;
}

export interface SocialLinkOut {
  id: Uuid;
  kind: SocialLinkKind;
  url: string;
}

export interface ContactOut {
  id: Uuid;
  kind: ContactKind;
  value: string;
  added_by_person_id: Uuid | null;
}

export interface PersonOut {
  id: Uuid;
  name_ar: string | null;
  name_latin: string | null;
  display_name: string;
  headline: string | null;
  organization: string | null;
  profession: string | null;
  seniority: Seniority | null;
  available_for: AvailableFor[];
  city: string | null;
  country: string | null;
  admin_notes: string | null;
  photo_path: string | null;
  last_confirmed_at: IsoDateTime;
  is_stale: boolean;
  created_by_person_id: Uuid | null;
  created_via: 'admin' | 'link';
  contributor_link_id: Uuid | null;
  created_at: IsoDateTime;
  skills: SkillOut[];
  industries: IndustryOut[];
  social_links: SocialLinkOut[];
  contacts: ContactOut[];
  connections: ConnectionOut[];
}

export interface DuplicateHint {
  person_id: Uuid;
  display_name: string;
  matched_on: 'phone' | 'whatsapp' | 'email' | 'social_link';
}

export interface CreatePersonResponse {
  person: PersonOut;
  possible_duplicates: DuplicateHint[];
}

export interface TagOut {
  id: Uuid;
  label: string;
  category: SkillCategory | null;
}

/** Query of `GET /tags`. */
export interface TagQuery {
  kind: TagKind;
  q?: string;
}

// -- search -------------------------------------------------------------------------------------

/** Query of `GET /search`; `skill` repeats (the person needs all of them). At least one criterion. */
export interface SearchQuery {
  q?: string;
  skill?: string[];
  category?: SkillCategory;
  min_level?: SkillLevel;
  industry?: string;
  seniority?: Seniority;
  available_for?: AvailableFor;
  city?: string;
  /** 1 to 50, default 20. */
  limit?: number;
}

export interface PathNode {
  person_id: Uuid;
  display_name: string;
}

export interface MatchedSkill {
  label: string;
  level: SkillLevel | null;
}

export interface SearchResult {
  person_id: Uuid;
  display_name: string;
  profession: string | null;
  headline: string | null;
  city: string | null;
  matched_skills: MatchedSkill[];
  available_for: AvailableFor[];
  last_confirmed_at: IsoDateTime;
  is_stale: boolean;
  /** Owner first, target last; empty when the person cannot be reached from the owner. */
  path: PathNode[];
  /** Total path weight (strong 1, normal 2, weak 3); null when unreachable. */
  cost: number | null;
  /** Hops on the path (people on it minus one); 0 when unreachable. */
  steps: number;
}

/** Response of `GET /people/{id}/paths?k=` (k is 1 to 10, default 3). */
export interface AlternativePath {
  cost: number;
  path: PathNode[];
}

// -- duplicates and merge -----------------------------------------------------------------------

export interface PersonSummary {
  person_id: Uuid;
  display_name: string;
  profession: string | null;
  city: string | null;
}

/** `phone` covers phone and WhatsApp numbers alike (one normal form). */
export interface DuplicatePair {
  a: PersonSummary;
  b: PersonSummary;
  matched_on: ('email' | 'phone' | 'social_link')[];
}

export interface DismissRequest {
  a: Uuid;
  b: Uuid;
}

export interface MergeRequest {
  keep: Uuid;
  drop: Uuid;
}

// -- review lists -------------------------------------------------------------------------------

export interface ReviewPerson extends PersonSummary {
  last_confirmed_at: IsoDateTime;
}

// -- contributor links --------------------------------------------------------------------------

export interface CreateLinkRequest {
  person_id: Uuid;
}

/** A link with its token. The URL is shown once: only the token's sha256 is stored. */
export interface IssuedLink {
  link_id: Uuid;
  url: string;
  expires_at: IsoDateTime;
}

export interface LinkOut {
  link_id: Uuid;
  person_id: Uuid;
  display_name: string;
  expires_at: IsoDateTime;
  revoked_at: IsoDateTime | null;
  people_added: number;
}

/** PersonInput as a contributor may send it: no admin notes, no unknown keys, bounded lists. */
export type ContributorPersonInput = Omit<PersonInput, 'admin_notes'>;

export interface ContributeRequest {
  person: ContributorPersonInput;
  strength: Strength;
}

export interface ContributeResponse {
  person_id: Uuid;
}

export interface ContributorInfo {
  contributor_display_name: string;
  expires_at: IsoDateTime;
}

export interface ContributorTag {
  label: string;
  category: SkillCategory | null;
}
