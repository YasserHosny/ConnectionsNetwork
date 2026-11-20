import { forgetToken, takeToken } from './contribute-api';

const TOKEN = 'T0KEN_abc-123_SECRET';
const STORED = 'connections.contributeToken';

function setHash(hash: string): void {
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

describe('the contributor token', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    setHash('');
  });

  it('is taken from the fragment, which is removed, and kept for this tab only', () => {
    setHash(`#${TOKEN}`);

    expect(takeToken()).toEqual({ token: TOKEN });
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem(STORED)).toBe(TOKEN);
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN);
  });

  it('is found again after a reload (no fragment any more)', () => {
    setHash(`#${TOKEN}`);
    takeToken();

    expect(takeToken()).toEqual({ token: TOKEN });
  });

  it('a new link in the fragment replaces the kept one', () => {
    sessionStorage.setItem(STORED, 'old_token');
    setHash(`#${TOKEN}`);

    expect(takeToken()).toEqual({ token: TOKEN });
  });

  it('is missing when there is no fragment and nothing kept', () => {
    expect(takeToken()).toEqual({ token: null, reason: 'missing' });
  });

  it('a malformed fragment is not a token, and forgets the kept one', () => {
    sessionStorage.setItem(STORED, TOKEN);
    setHash('#bad token');

    expect(takeToken()).toEqual({ token: null, reason: 'malformed' });
    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it('is forgotten once the link is dead', () => {
    sessionStorage.setItem(STORED, TOKEN);

    forgetToken();

    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it('survives a storage that throws', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    setHash(`#${TOKEN}`);

    expect(takeToken()).toEqual({ token: TOKEN });
    expect(takeToken()).toEqual({ token: null, reason: 'missing' });
  });
});
