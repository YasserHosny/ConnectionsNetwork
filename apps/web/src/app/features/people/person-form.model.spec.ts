import type { PersonOut } from '@connections/domain-types';

import {
  emptyPersonFormValue,
  parseFormValue,
  personFormValueFrom,
  toNewPersonRequest,
  toPersonInput,
} from './person-form.model';

describe('person form model', () => {
  it('sends blanks as null and drops empty link and contact rows', () => {
    const input = toPersonInput({
      ...emptyPersonFormValue(),
      nameLatin: '  Sara Ali ',
      city: '   ',
      socialLinks: [
        { kind: 'github', url: ' https://github.com/sara ' },
        { kind: 'x', url: '  ' },
      ],
      contacts: [
        { kind: 'phone', value: ' 0101 ' },
        { kind: 'email', value: '' },
      ],
    });

    expect(input.name_ar).toBeNull();
    expect(input.name_latin).toBe('Sara Ali');
    expect(input.city).toBeNull();
    expect(input.social_links).toEqual([{ kind: 'github', url: 'https://github.com/sara' }]);
    expect(input.contacts).toEqual([{ kind: 'phone', value: '0101' }]);
  });

  it('connects a new person to the admin unless someone else is picked', () => {
    const base = { ...emptyPersonFormValue(), nameLatin: 'Sara', strength: 'weak' as const };

    expect(toNewPersonRequest(base, 'admin-1').connect_to_person_id).toBe('admin-1');
    expect(
      toNewPersonRequest({ ...base, connectTo: { id: 'p-2', name: 'Omar' } }, 'admin-1').connect_to_person_id,
    ).toBe('p-2');
    expect(toNewPersonRequest({ ...base, connectionNote: ' ' }, 'admin-1').connection_note).toBeNull();
  });

  it('refuses to build a create request without a strength', () => {
    expect(() => toNewPersonRequest(emptyPersonFormValue(), 'admin-1')).toThrow();
  });

  it('round-trips a person through the form value', () => {
    const person = {
      name_ar: 'سارة',
      name_latin: null,
      headline: null,
      organization: null,
      profession: 'Designer',
      seniority: null,
      available_for: [],
      city: null,
      country: null,
      admin_notes: null,
      skills: [{ tag_id: 't', label: 'Figma', category: 'technical', level: null }],
      industries: [],
      social_links: [],
      contacts: [],
    } as unknown as PersonOut;

    const input = toPersonInput({ ...emptyPersonFormValue(), ...personFormValueFrom(person) });

    expect(input.name_ar).toBe('سارة');
    expect(input.profession).toBe('Designer');
    expect(input.skills).toEqual([{ label: 'Figma', category: 'technical', level: null }]);
  });

  describe('parseFormValue', () => {
    it('rejects anything that is not an object', () => {
      expect(parseFormValue(null)).toBeNull();
      expect(parseFormValue('draft')).toBeNull();
    });

    it('keeps well-formed fields and empties the rest', () => {
      const value = parseFormValue({
        nameLatin: 'Sara',
        nameAr: 7,
        strength: 'huge',
        seniority: 'manager',
        availableFor: ['freelance', 'napping'],
        skills: [{ label: 'Python', category: 'technical', level: 'good' }, { label: 'x', category: 'nope' }, 'junk'],
        contacts: [{ kind: 'phone', value: '0101' }, { kind: 'fax', value: '1' }],
        connectTo: { id: 'p-1', name: 'Omar' },
      });

      expect(value).toEqual({
        ...emptyPersonFormValue(),
        nameLatin: 'Sara',
        seniority: 'manager',
        availableFor: ['freelance'],
        skills: [{ label: 'Python', category: 'technical', level: 'good' }],
        contacts: [{ kind: 'phone', value: '0101' }],
        connectTo: { id: 'p-1', name: 'Omar' },
      });
    });
  });
});
