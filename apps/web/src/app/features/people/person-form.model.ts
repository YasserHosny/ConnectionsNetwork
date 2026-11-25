import type {
  AvailableFor,
  ContactInput,
  ContactKind,
  NewPersonRequest,
  PersonInput,
  PersonOut,
  Seniority,
  SkillCategory,
  SkillInput,
  SkillLevel,
  SocialLinkInput,
  SocialLinkKind,
  Strength,
  TagKind,
} from '@connections/domain-types';
import type { Observable } from 'rxjs';

/** An autocomplete answer: `/tags` for the admin, `/contribute/tags` for a contributor (Task 16). */
export interface TagSuggestion {
  label: string;
  category: SkillCategory | null;
}

/** Looks up suggestions for the tags being typed (kind `skill` or `industry`). */
export type TagSuggest = (kind: TagKind, q: string) => Observable<TagSuggestion[]>;

/** A tag as the tag input holds it; industries have no category and skills may have no level. */
export interface TagValue {
  label: string;
  category: SkillCategory | null;
  level: SkillLevel | null;
}

/** Who the new person is connected to, when not the admin. */
export interface ConnectTarget {
  id: string;
  name: string;
}

/**
 * Everything the person form edits, as plain data. It is also what a draft holds, so it must stay
 * JSON-serialisable. `connectTo: null` means "the admin" (spec 8.3's default).
 */
export interface PersonFormValue {
  nameAr: string;
  nameLatin: string;
  strength: Strength | null;
  connectTo: ConnectTarget | null;
  connectionNote: string;
  headline: string;
  organization: string;
  profession: string;
  seniority: Seniority | null;
  availableFor: AvailableFor[];
  city: string;
  country: string;
  adminNotes: string;
  skills: SkillInput[];
  industries: string[];
  socialLinks: SocialLinkInput[];
  contacts: ContactInput[];
}

export function emptyPersonFormValue(): PersonFormValue {
  return {
    nameAr: '',
    nameLatin: '',
    strength: null,
    connectTo: null,
    connectionNote: '',
    headline: '',
    organization: '',
    profession: '',
    seniority: null,
    availableFor: [],
    city: '',
    country: '',
    adminNotes: '',
    skills: [],
    industries: [],
    socialLinks: [],
    contacts: [],
  };
}

// -- value sets with their i18n keys (literal keys, so `check-i18n-keys` can see them) ---------

interface Option<T extends string> {
  value: T;
  labelKey: string;
}

/** The i18n key for one value of a value set, for showing a stored value as text. */
export function labelKeyOf<T extends string>(
  options: readonly { value: T; labelKey: string }[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.labelKey ?? '';
}

export const STRENGTH_OPTIONS: readonly Option<Strength>[] = [
  { value: 'strong', labelKey: 'person.strength.strong' },
  { value: 'normal', labelKey: 'person.strength.normal' },
  { value: 'weak', labelKey: 'person.strength.weak' },
];

export const SENIORITY_OPTIONS: readonly Option<Seniority>[] = [
  { value: 'employee', labelKey: 'person.seniority.employee' },
  { value: 'manager', labelKey: 'person.seniority.manager' },
  { value: 'decision_maker', labelKey: 'person.seniority.decisionMaker' },
  { value: 'business_owner', labelKey: 'person.seniority.businessOwner' },
];

export const AVAILABLE_FOR_OPTIONS: readonly Option<AvailableFor>[] = [
  { value: 'job_seeking', labelKey: 'person.availableFor.jobSeeking' },
  { value: 'freelance', labelKey: 'person.availableFor.freelance' },
  { value: 'offers_service', labelKey: 'person.availableFor.offersService' },
  { value: 'partner_seeking', labelKey: 'person.availableFor.partnerSeeking' },
];

export const SKILL_CATEGORY_OPTIONS: readonly Option<SkillCategory>[] = [
  { value: 'technical', labelKey: 'person.skillCategory.technical' },
  { value: 'languages', labelKey: 'person.skillCategory.languages' },
  { value: 'sports', labelKey: 'person.skillCategory.sports' },
  { value: 'arts_literature', labelKey: 'person.skillCategory.artsLiterature' },
  { value: 'culture', labelKey: 'person.skillCategory.culture' },
  { value: 'crafts_trades', labelKey: 'person.skillCategory.craftsTrades' },
  { value: 'business', labelKey: 'person.skillCategory.business' },
  { value: 'other', labelKey: 'person.skillCategory.other' },
];

export const SKILL_LEVEL_OPTIONS: readonly Option<SkillLevel>[] = [
  { value: 'basic', labelKey: 'person.skillLevel.basic' },
  { value: 'good', labelKey: 'person.skillLevel.good' },
  { value: 'expert', labelKey: 'person.skillLevel.expert' },
];

export const SOCIAL_KIND_OPTIONS: readonly Option<SocialLinkKind>[] = [
  { value: 'facebook', labelKey: 'person.socialKind.facebook' },
  { value: 'x', labelKey: 'person.socialKind.x' },
  { value: 'linkedin', labelKey: 'person.socialKind.linkedin' },
  { value: 'instagram', labelKey: 'person.socialKind.instagram' },
  { value: 'github', labelKey: 'person.socialKind.github' },
  { value: 'website', labelKey: 'person.socialKind.website' },
];

export const CONTACT_KIND_OPTIONS: readonly Option<ContactKind>[] = [
  { value: 'phone', labelKey: 'person.contactKind.phone' },
  { value: 'whatsapp', labelKey: 'person.contactKind.whatsapp' },
  { value: 'email', labelKey: 'person.contactKind.email' },
];

/** Label key per duplicate hint reason (`DuplicateHint.matched_on`). */
export const MATCHED_ON_KEYS: Record<string, string> = {
  phone: 'person.duplicates.matchedOn.phone',
  whatsapp: 'person.duplicates.matchedOn.whatsapp',
  email: 'person.duplicates.matchedOn.email',
  social_link: 'person.duplicates.matchedOn.socialLink',
};

// -- conversions --------------------------------------------------------------------------------

const orNull = (text: string): string | null => text.trim() || null;

export function hasName(value: Pick<PersonFormValue, 'nameAr' | 'nameLatin'>): boolean {
  return !!(value.nameAr.trim() || value.nameLatin.trim());
}

/** True when any field under "More details" has a value (so that section starts open). */
export function hasOptionalValues(value: PersonFormValue): boolean {
  return !!(
    value.connectionNote.trim() ||
    value.headline.trim() ||
    value.organization.trim() ||
    value.profession.trim() ||
    value.seniority ||
    value.availableFor.length ||
    value.city.trim() ||
    value.country.trim() ||
    value.adminNotes.trim() ||
    value.skills.length ||
    value.industries.length ||
    value.socialLinks.length
  );
}

/** The API's `PersonInput`: text trimmed, blanks sent as null, empty link and contact rows dropped. */
export function toPersonInput(value: PersonFormValue): PersonInput {
  return {
    name_ar: orNull(value.nameAr),
    name_latin: orNull(value.nameLatin),
    headline: orNull(value.headline),
    organization: orNull(value.organization),
    profession: orNull(value.profession),
    seniority: value.seniority,
    available_for: value.availableFor,
    city: orNull(value.city),
    country: orNull(value.country),
    admin_notes: orNull(value.adminNotes),
    skills: value.skills.map((s) => ({ label: s.label, category: s.category, level: s.level ?? null })),
    industries: value.industries,
    social_links: value.socialLinks
      .map((l) => ({ kind: l.kind, url: l.url.trim() }))
      .filter((l) => l.url),
    contacts: value.contacts
      .map((c) => ({ kind: c.kind, value: c.value.trim() }))
      .filter((c) => c.value),
  };
}

/** The create request; the connection goes to `connectTo`, or to the admin when it is null. */
export function toNewPersonRequest(value: PersonFormValue, adminPersonId: string): NewPersonRequest {
  if (!value.strength) throw new Error('strength is required');
  return {
    person: toPersonInput(value),
    connect_to_person_id: value.connectTo?.id ?? adminPersonId,
    strength: value.strength,
    connection_note: orNull(value.connectionNote),
  };
}

/** The edit form's starting point: everything the API holds about the person. */
export function personFormValueFrom(person: PersonOut): Partial<PersonFormValue> {
  return {
    nameAr: person.name_ar ?? '',
    nameLatin: person.name_latin ?? '',
    headline: person.headline ?? '',
    organization: person.organization ?? '',
    profession: person.profession ?? '',
    seniority: person.seniority,
    availableFor: person.available_for,
    city: person.city ?? '',
    country: person.country ?? '',
    adminNotes: person.admin_notes ?? '',
    skills: person.skills.map((s) => ({ label: s.label, category: s.category, level: s.level })),
    industries: person.industries.map((i) => i.label),
    socialLinks: person.social_links.map((l) => ({ kind: l.kind, url: l.url })),
    contacts: person.contacts.map((c) => ({ kind: c.kind, value: c.value })),
  };
}

// -- reading a draft back ---------------------------------------------------------------------

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const oneOf = <T extends string>(values: readonly Option<T>[], x: unknown): x is T =>
  values.some((o) => o.value === x);

/**
 * A draft read from storage may be from an older version or damaged. Keep every field that has
 * the right shape and fall back to the empty value for the rest; null when it is not an object.
 */
export function parseFormValue(raw: unknown): PersonFormValue | null {
  if (!isObject(raw)) return null;
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const list = (key: string): unknown[] => (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []);

  const connectTo = raw['connectTo'];
  return {
    nameAr: text('nameAr'),
    nameLatin: text('nameLatin'),
    strength: oneOf(STRENGTH_OPTIONS, raw['strength']) ? raw['strength'] : null,
    connectTo:
      isObject(connectTo) && typeof connectTo['id'] === 'string' && typeof connectTo['name'] === 'string'
        ? { id: connectTo['id'], name: connectTo['name'] }
        : null,
    connectionNote: text('connectionNote'),
    headline: text('headline'),
    organization: text('organization'),
    profession: text('profession'),
    seniority: oneOf(SENIORITY_OPTIONS, raw['seniority']) ? raw['seniority'] : null,
    availableFor: list('availableFor').filter((x): x is AvailableFor => oneOf(AVAILABLE_FOR_OPTIONS, x)),
    city: text('city'),
    country: text('country'),
    adminNotes: text('adminNotes'),
    skills: list('skills').flatMap((x): SkillInput[] =>
      isObject(x) && typeof x['label'] === 'string' && oneOf(SKILL_CATEGORY_OPTIONS, x['category'])
        ? [{ label: x['label'], category: x['category'], level: oneOf(SKILL_LEVEL_OPTIONS, x['level']) ? x['level'] : null }]
        : [],
    ),
    industries: list('industries').filter((x): x is string => typeof x === 'string'),
    socialLinks: list('socialLinks').flatMap((x): SocialLinkInput[] =>
      isObject(x) && typeof x['url'] === 'string' && oneOf(SOCIAL_KIND_OPTIONS, x['kind'])
        ? [{ kind: x['kind'], url: x['url'] }]
        : [],
    ),
    contacts: list('contacts').flatMap((x): ContactInput[] =>
      isObject(x) && typeof x['value'] === 'string' && oneOf(CONTACT_KIND_OPTIONS, x['kind'])
        ? [{ kind: x['kind'], value: x['value'] }]
        : [],
    ),
  };
}
