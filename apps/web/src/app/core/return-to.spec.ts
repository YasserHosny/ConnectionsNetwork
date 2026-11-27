import { safeReturn, withReturn } from './return-to';

describe('returning after signing in again', () => {
  it('keeps an in-app path with its query', () => {
    expect(safeReturn('/people/p-7')).toBe('/people/p-7');
    expect(safeReturn('/search?q=seo&city=Cairo')).toBe('/search?q=seo&city=Cairo');
  });

  it('refuses anything that could leave the app, and the sign-in pages themselves', () => {
    for (const value of [null, '', 'people', '//evil.example/x', '/\\evil.example', 'https://evil.example', '/login', '/mfa?next=/x', '/c']) {
      expect(safeReturn(value)).withContext(String(value)).toBe('/');
    }
  });

  it('never carries a contact value into the sign-in URL, keeping the other filters', () => {
    expect(safeReturn('/search?q=qa%40example.test&city=Cairo')).toBe('/search?city=Cairo');
    expect(safeReturn('/search?q=0101%20234%205678')).toBe('/search');
    expect(withReturn('/login', '/search?q=Sara%2001012345678')).toBe('/login?next=%2Fsearch');
  });

  it('drops a fragment (the contributor token rides in one)', () => {
    expect(safeReturn('/people/p-7#x')).toBe('/people/p-7');
  });

  it('adds next only when there is somewhere to return to', () => {
    expect(withReturn('/login', '/people/p-7')).toBe('/login?next=%2Fpeople%2Fp-7');
    expect(withReturn('/mfa', '/')).toBe('/mfa');
    expect(withReturn('/login', '/login')).toBe('/login');
  });
});
