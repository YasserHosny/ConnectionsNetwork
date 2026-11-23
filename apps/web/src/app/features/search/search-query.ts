import type { ParamMap, Params } from '@angular/router';
import {
  AVAILABLE_FOR,
  SENIORITIES,
  SKILL_CATEGORIES,
  SKILL_LEVELS,
  type AvailableFor,
  type SearchQuery,
  type Seniority,
  type SkillCategory,
  type SkillLevel,
} from '@connections/domain-types';

import type { QueryParams } from '../../core/api.client';
import { containsContactValue } from '../../core/contact-value';

/** The most people one search returns (the API's cap); there is no paging. */
export const RESULT_LIMIT = 50;

/** The search form: '' means "not set". */
export interface SearchFilters {
  q: string;
  category: SkillCategory | '';
  minLevel: SkillLevel | '';
  industry: string;
  seniority: Seniority | '';
  availableFor: AvailableFor | '';
  city: string;
}

export const EMPTY_FILTERS: SearchFilters = {
  q: '',
  category: '',
  minLevel: '',
  industry: '',
  seniority: '',
  availableFor: '',
  city: '',
};

/**
 * Text that contains a contact value: an email address or a phone number (seven or more digits,
 * Arabic-Indic included, however they are grouped), alone or inside other text ("Sara 010…").
 * Contact values are not searchable and must never reach a URL, so such text is neither searched
 * nor written to the query string.
 */
export function isContactLike(text: string): boolean {
  return containsContactValue(text);
}

export function hasCriteria(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) => value.trim() !== '');
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | '' {
  return allowed.find((candidate) => candidate === value) ?? '';
}

/** The free-text filters: the ones a contact value could be typed or pasted into. */
export function hasContactValue(filters: Pick<SearchFilters, 'q' | 'industry' | 'city'>): boolean {
  return [filters.q, filters.industry, filters.city].some(isContactLike);
}

/**
 * The filters a query string describes. A contact-like `q`, `industry` or `city` is dropped and
 * reported through `contactLike`, so the page can say why and clean the address bar.
 */
export function filtersFromParams(params: ParamMap): { filters: SearchFilters; contactLike: boolean } {
  let contactLike = false;
  const text = (name: string) => {
    const value = (params.get(name) ?? '').trim();
    if (!isContactLike(value)) return value;
    contactLike = true;
    return '';
  };
  const filters: SearchFilters = {
    q: text('q'),
    category: oneOf(SKILL_CATEGORIES, params.get('category')),
    minLevel: oneOf(SKILL_LEVELS, params.get('min_level')),
    industry: text('industry'),
    seniority: oneOf(SENIORITIES, params.get('seniority')),
    availableFor: oneOf(AVAILABLE_FOR, params.get('available_for')),
    city: text('city'),
  };
  return { contactLike, filters };
}

function setFilters(filters: SearchFilters): Record<string, string> {
  const named: Record<string, string> = {
    q: filters.q,
    category: filters.category,
    min_level: filters.minLevel,
    industry: filters.industry,
    seniority: filters.seniority,
    available_for: filters.availableFor,
    city: filters.city,
  };
  return Object.fromEntries(
    Object.entries(named)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value !== ''),
  );
}

/** The query string for these filters: only what is set, under the API's own names. */
export function toUrlParams(filters: SearchFilters): Params {
  return setFilters(filters);
}

/** The `GET /search` parameters for these filters. */
export function toApiParams(filters: SearchFilters): QueryParams {
  const set = setFilters(filters);
  const query: SearchQuery = { ...set, limit: RESULT_LIMIT };
  return { ...query };
}
