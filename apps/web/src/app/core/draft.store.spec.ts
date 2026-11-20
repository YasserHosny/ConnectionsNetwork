import { TestBed } from '@angular/core/testing';

import { DraftStore } from './draft.store';

describe('DraftStore', () => {
  let store: DraftStore;

  beforeEach(() => {
    localStorage.clear();
    store = TestBed.inject(DraftStore);
  });

  afterEach(() => localStorage.clear());

  it('saves, loads and clears a draft under its own key', () => {
    store.save('add-person', { nameLatin: 'Sara' });
    store.save('edit-person:7', { nameLatin: 'Omar' });

    expect(store.load('add-person')).toEqual({ nameLatin: 'Sara' });
    expect(store.load('edit-person:7')).toEqual({ nameLatin: 'Omar' });

    store.clear('add-person');

    expect(store.load('add-person')).toBeNull();
    expect(store.load('edit-person:7')).toEqual({ nameLatin: 'Omar' });
  });

  it('returns null for a missing or corrupt draft', () => {
    expect(store.load('add-person')).toBeNull();

    store.save('add-person', 1);
    for (let i = 0; i < localStorage.length; i++) {
      localStorage.setItem(localStorage.key(i) as string, '{not json');
    }

    expect(store.load('add-person')).toBeNull();
  });

  it('survives a throwing localStorage', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('quota exceeded');
    spyOn(Storage.prototype, 'getItem').and.throwError('access denied');
    spyOn(Storage.prototype, 'removeItem').and.throwError('access denied');

    expect(() => store.save('add-person', { a: 1 })).not.toThrow();
    expect(store.load('add-person')).toBeNull();
    expect(() => store.clear('add-person')).not.toThrow();
  });
});
