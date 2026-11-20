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

/** The most people one search returns (the API's cap); there is no paging. */
export const RESULT_LIMIT = 50;

const MIN_PHONE_DIGITS = 6;

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
 * Text that looks like a contact value: a phone number (only digits, spaces and + ( ) - ., at least
 * 6 digits, Arabic-Indic digits included) or an email address. Contact values are not searchable
 * and must never reach a URL, so such text is neither searched nor written to the query string.
 */
export function isContactLike(text: string): boolean {
  const value = text.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return true;
  if (!/^[\d٠-٩۰-۹\s+().-]+$/.test(value)) return false;
  return (value.match(/[\d٠-٩۰-۹]/g) ?? []).length >= MIN_PHONE_DIGITS;
}

export function hasCriteria(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) => value.trim() !== '');
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | '' {
  return allowed.find((candidate) => candidate === value) ?? '';
}

/**
 * The filters a query string describes. A contact-like `q` is dropped and reported through
 * `contactLike`, so the page can say why and clean the address bar.
 */
export function filtersFromParams(params: ParamMap): { filters: SearchFilters; contactLike: boolean } {
  const text = (name: string) => (params.get(name) ?? '').trim();
  const q = text('q');
  const contactLike = isContactLike(q);
  return {
    contactLike,
    filters: {
      q: contactLike ? '' : q,
      category: oneOf(SKILL_CATEGORIES, params.get('category')),
      minLevel: oneOf(SKILL_LEVELS, params.get('min_level')),
      industry: text('industry'),
      seniority: oneOf(SENIORITIES, params.get('seniority')),
      availableFor: oneOf(AVAILABLE_FOR, params.get('available_for')),
      city: text('city'),
    },
  };
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
