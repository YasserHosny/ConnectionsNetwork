import { webHref } from './social-links';

describe('webHref', () => {
  it('keeps an http or https address', () => {
    expect(webHref('https://linkedin.com/in/sara')).toBe('https://linkedin.com/in/sara');
    expect(webHref(' http://example.com ')).toBe('http://example.com');
  });

  it('opens an address without a scheme on the web, not inside the app', () => {
    expect(webHref('linkedin.com/in/sara')).toBe('https://linkedin.com/in/sara');
    expect(webHref('www.facebook.com/sara')).toBe('https://www.facebook.com/sara');
    expect(webHref('example.com:8080/x')).toBe('https://example.com:8080/x');
  });

  it('gives no link for another scheme, a scheme-relative address or nothing', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.co', '//evil.example.com', '  ']) {
      expect(webHref(url)).withContext(url).toBeNull();
    }
  });
});
