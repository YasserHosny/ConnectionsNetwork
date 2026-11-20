import { contactHref } from './contact-links';

describe('contactHref', () => {
  it('dials the international form, Arabic-Indic digits read as digits', () => {
    expect(contactHref('phone', '٠١٠ ١٢٣٤ ٥٦٧٨')).toBe('tel:+201012345678');
    expect(contactHref('phone', '+20 10 1234-5678')).toBe('tel:+201012345678');
  });

  it('opens WhatsApp on the same number, and offers no link when it cannot be placed', () => {
    expect(contactHref('whatsapp', '010 1234 5678')).toBe('https://wa.me/201012345678');
    expect(contactHref('whatsapp', 'ask Karim')).toBeNull();
  });

  it('mails an email address, and offers nothing for an empty value', () => {
    expect(contactHref('email', ' sara@example.com ')).toBe('mailto:sara@example.com');
    expect(contactHref('phone', '  ')).toBeNull();
    expect(contactHref('phone', 'none')).toBeNull();
  });
});
