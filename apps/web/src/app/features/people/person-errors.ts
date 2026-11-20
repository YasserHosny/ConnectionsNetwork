import { ApiError } from '../../core/api.client';

/** What to tell the person about a failed save: i18n keys only, never `ApiError.message`. */
export interface PersonErrorMessage {
  key: string;
  /** For `person.errors.invalidField`: the label key of the field that was rejected. */
  fieldKey: string | null;
  /** Network failure or server error: the request may succeed later, so keep a draft and offer retry. */
  retryable: boolean;
}

/** The request never got an answer, or the server failed: nothing about the data was refused. */
export function isRetryable(error: ApiError): boolean {
  return error.status === 0 || error.status >= 500;
}

/** API field (`person.name_ar`, `person.skills[0].label`, `strength`) to its form label key. */
const FIELD_LABEL_KEYS: Record<string, string> = {
  name_ar: 'person.form.nameAr',
  name_latin: 'person.form.nameLatin',
  headline: 'person.form.headline',
  organization: 'person.form.organization',
  profession: 'person.form.profession',
  seniority: 'person.form.seniority',
  available_for: 'person.form.availableFor',
  city: 'person.form.city',
  country: 'person.form.country',
  admin_notes: 'person.form.adminNotes',
  skills: 'person.form.skills',
  industries: 'person.form.industries',
  social_links: 'person.form.socialLinks',
  contacts: 'person.form.contacts',
  connection_note: 'person.form.connectionNote',
  connect_to_person_id: 'person.connectTo.label',
  strength: 'person.strength.label',
};

function detailList(error: ApiError): Record<string, unknown>[] {
  const { details } = error;
  if (Array.isArray(details)) return details;
  return details ? [details] : [];
}

function fieldLabelKey(field: unknown): string | null {
  if (typeof field !== 'string') return null;
  const name = field.replace(/^person\./, '').split(/[.[]/)[0];
  return FIELD_LABEL_KEYS[name] ?? null;
}

function validationMessage(error: ApiError): PersonErrorMessage {
  const details = detailList(error);
  const reasons = details.map((d) => d['reason']);
  if (reasons.includes('person_not_found')) return message('person.errors.personNotFound');

  // The model validator that wants a name reports on the whole `person` object.
  if (details.some((d) => d['field'] === 'person' && d['type'] === 'value_error')) {
    return message('person.errors.nameRequired');
  }
  if (details.some((d) => d['field'] === 'strength')) return message('person.errors.strengthRequired');

  for (const detail of details) {
    const fieldKey = fieldLabelKey(detail['field']);
    if (fieldKey) return { key: 'person.errors.invalidField', fieldKey, retryable: false };
  }
  return message('person.errors.invalid');
}

function message(key: string, retryable = false): PersonErrorMessage {
  return { key, fieldKey: null, retryable };
}

/** Maps an API failure to a translated message; known codes and fields get a specific one. */
export function personErrorMessage(error: ApiError): PersonErrorMessage {
  if (isRetryable(error)) return message('person.errors.savedOnDevice', true);
  switch (error.code) {
    case 'validation.invalid_request':
    case 'validation.invalid_value':
      return validationMessage(error);
    case 'conflict':
      return message('person.errors.alreadyConnected');
    case 'not_found':
      return message('person.errors.notFound');
    default:
      // The auth codes are matched by status: a code like `auth.forbidden` would read as an i18n key.
      if (error.status === 401) return message('person.errors.sessionEnded');
      if (error.status === 403) return message('person.errors.forbidden');
      return message('person.errors.generic');
  }
}
