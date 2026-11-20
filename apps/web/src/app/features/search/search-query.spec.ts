import { convertToParamMap } from '@angular/router';

import {
  EMPTY_FILTERS,
  filtersFromParams,
  hasCriteria,
  isContactLike,
  toApiParams,
  toUrlParams,
} from './search-query';

describe('isContactLike', () => {
  it('is true for phone-like text: digits, spaces and + ( ) - . with at least 6 digits', () => {
    expect(isContactLike('01012345678')).toBeTrue();
    expect(isContactLike('+20 10 1234-5678')).toBeTrue();
    expect(isContactLike('(010) 123.4567')).toBeTrue();
    expect(isContactLike('٠١٠١٢٣٤٥٦٧٨')).toBeTrue();
  });

  it('is true for an email address', () => {
    expect(isContactLike('sara@example.com')).toBeTrue();
  });

  it('is false for names, skills and short numbers', () => {
    expect(isContactLike('Sara Mahmoud')).toBeFalse();
    expect(isContactLike('سارة')).toBeFalse();
    expect(isContactLike('seo 2024')).toBeFalse();
    expect(isContactLike('12345')).toBeFalse();
    expect(isContactLike('')).toBeFalse();
  });
});

describe('search filters in the URL', () => {
  it('reads known filters from the query string and ignores unknown values', () => {
    const { filters, contactLike } = filtersFromParams(
      convertToParamMap({
        q: ' sara ',
        category: 'technical',
        min_level: 'expert',
        industry: 'Banking',
        seniority: 'nope',
        available_for: 'freelance',
        city: 'Cairo',
      }),
    );

    expect(contactLike).toBeFalse();
    expect(filters).toEqual({
      q: 'sara',
      category: 'technical',
      minLevel: 'expert',
      industry: 'Banking',
      seniority: '',
      availableFor: 'freelance',
      city: 'Cairo',
    });
  });

  it('drops a contact-like q and says so, so it never stays in the URL', () => {
    const { filters, contactLike } = filtersFromParams(convertToParamMap({ q: '01012345678', city: 'Cairo' }));

    expect(contactLike).toBeTrue();
    expect(filters.q).toBe('');
    expect(filters.city).toBe('Cairo');
  });

  it('writes only the filters that are set', () => {
    expect(toUrlParams({ ...EMPTY_FILTERS, q: 'sara', minLevel: 'good' })).toEqual({
      q: 'sara',
      min_level: 'good',
    });
    expect(toUrlParams(EMPTY_FILTERS)).toEqual({});
  });

  it('sends the API its own parameter names and a limit', () => {
    expect(toApiParams({ ...EMPTY_FILTERS, q: 'sara', availableFor: 'freelance' })).toEqual({
      q: 'sara',
      available_for: 'freelance',
      limit: 50,
    });
  });

  it('counts a search as having criteria only when something is filled in', () => {
    expect(hasCriteria(EMPTY_FILTERS)).toBeFalse();
    expect(hasCriteria({ ...EMPTY_FILTERS, q: '  ' })).toBeFalse();
    expect(hasCriteria({ ...EMPTY_FILTERS, minLevel: 'basic' })).toBeTrue();
  });
});
