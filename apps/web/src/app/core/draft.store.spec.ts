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

  it('clears every draft at once, and nothing else in storage', () => {
    store.save('add-person', { nameLatin: 'Sara' });
    store.save('edit-person:7', { nameLatin: 'Omar' });
    store.save('contribute', { nameLatin: 'Hoda' });
    localStorage.setItem('connections.locale', 'en');

    store.clearAll();

    expect(store.load('add-person')).toBeNull();
    expect(store.load('edit-person:7')).toBeNull();
    expect(store.load('contribute')).toBeNull();
    expect(localStorage.getItem('connections.locale')).toBe('en');
  });

  it('counts explicit clear-alls, so a write started before one can tell it is stale', () => {
    const store = new DraftStore();
    const before = store.generation;

    store.clearAll();

    expect(store.generation).toBe(before + 1);
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
