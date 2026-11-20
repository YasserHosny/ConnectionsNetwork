import { arCatalog } from '@connections/i18n';

import { buildIntroMessage, phoneDigits, pickWhatsappNumber, whatsappUrl } from './intro-message';

const node = (display_name: string) => ({ display_name });
/** A name as the message carries it: isolated, so it keeps its own direction (core/bidi). */
const iso = (name: string) => `\u2068${name}\u2069`;

const FOUR = [node('أنا'), node('أحمد'), node('كريم'), node('سارة محمود')];

describe('buildIntroMessage', () => {
  it('ar for a 4-node path names the first hop, the target and the penultimate person', () => {
    const text = buildIntroMessage('ar', FOUR);

    expect(text).toContain('أحمد');
    expect(text).toContain('سارة محمود');
    expect(text).toContain('كريم');
    expect(text).not.toContain('أنا');
    expect(text).not.toContain('{{');
    // The wording comes from the Arabic catalogue, not from English.
    expect(text.startsWith(arCatalog.search.intro.ask.split('{{')[0])).toBeTrue();
  });

  it('en for a 4-node path reads as a request to the first hop with the penultimate person named', () => {
    const text = buildIntroMessage('en', [node('Me'), node('Ahmed'), node('Karim'), node('Sara Mahmoud')]);

    expect(text).toBe(
      `Hi ${iso('Ahmed')}, do you know someone who can introduce me to ${iso('Sara Mahmoud')}? ` +
        `${iso('Karim')} knows ${iso('Sara Mahmoud')}.`,
    );
  });

  it('for a 3-node path asks the first hop, who knows the target, to introduce them directly', () => {
    const text = buildIntroMessage('en', [node('Me'), node('Ahmed'), node('Sara Mahmoud')]);

    expect(text).toBe(`Hi ${iso('Ahmed')}, could you introduce me to ${iso('Sara Mahmoud')}?`);
  });

  it('ar for a 3-node path asks directly too, from the Arabic catalogue', () => {
    const text = buildIntroMessage('ar', [node('أنا'), node('أحمد'), node('سارة')]);

    expect(text.startsWith(arCatalog.search.intro.askDirect.split('{{')[0])).toBeTrue();
    expect(text).toContain(iso('أحمد'));
    expect(text).toContain(iso('سارة'));
    expect(text).not.toContain('هل تعرف أحدًا');
  });

  it('ar says who knows the target without assuming anyone\'s gender', () => {
    const text = buildIntroMessage('ar', FOUR);

    expect(text).toContain(`${iso('كريم')} على معرفة بـ${iso('سارة محمود')}`);
  });

  it('for a 2-node path (direct) is not generated', () => {
    expect(buildIntroMessage('ar', [node('أنا'), node('سارة')])).toBe('');
    expect(buildIntroMessage('en', [node('Me')])).toBe('');
    expect(buildIntroMessage('en', [])).toBe('');
  });

  it('does not expand placeholders that appear inside a name', () => {
    const text = buildIntroMessage('en', [node('Me'), node('{{target}}'), node('Sara')]);

    expect(text).toBe(`Hi ${iso('{{target}}')}, could you introduce me to ${iso('Sara')}?`);
  });
});

describe('whatsappUrl', () => {
  // The same rules as the API's normalize_phone (rulings R7, R8): the number WhatsApp opens is the
  // one the duplicate check would see.
  const cases: [string, string][] = [
    ['+20 10 1234-5678', '201012345678'],
    ['010 1234 5678', '201012345678'],
    ['00201012345678', '201012345678'],
    ['٠١٠١٢٣٤٥٦٧٨', '201012345678'],
    ['۰۰۲۰۱۰۱۲۳۴۵۶۷۸', '201012345678'],
    ['201012345678', '201012345678'],
    ['1012345678', '201012345678'],
    ['+20 (0)10 1234 5678', '201012345678'],
    ['+44 7911 123456', '447911123456'],
    ['0044 7911 123456', '447911123456'],
    ['+44 (0)7911 123456', '447911123456'],
  ];
  for (const [typed, digits] of cases) {
    it(`opens ${typed} as wa.me/${digits}`, () => {
      expect(whatsappUrl(typed, 'x')).toBe(`https://wa.me/${digits}?text=x`);
    });
  }

  it('encodes the text, and leaves it off when there is none', () => {
    expect(whatsappUrl('+201012345678', 'Hi Ahmed & co?')).toBe(
      'https://wa.me/201012345678?text=Hi%20Ahmed%20%26%20co%3F',
    );
    expect(whatsappUrl('+201012345678', '')).toBe('https://wa.me/201012345678');
  });

  it('opens nobody when the number cannot be placed: never a stranger', () => {
    for (const value of ['', 'call me', '0000', '12345', '9876543210', '+', 'ext. 12']) {
      expect(whatsappUrl(value, 'x')).withContext(value).toBeNull();
    }
  });
});

describe('phoneDigits (tel: links)', () => {
  it('is the international form when the number can be placed, Arabic-Indic digits included', () => {
    expect(phoneDigits('٠١٠١٢٣٤٥٦٧٨')).toBe('+201012345678');
    expect(phoneDigits('+44 (0)7911 123456')).toBe('+447911123456');
  });

  it('keeps a short local number as its digits, and has nothing for no digits', () => {
    expect(phoneDigits('02 555 ١٢٣')).toBe('02555123');
    expect(phoneDigits('n/a')).toBeNull();
  });
});

describe('pickWhatsappNumber', () => {
  const phone = { kind: 'phone', value: '0100' } as const;
  const whatsapp = { kind: 'whatsapp', value: '0111' } as const;
  const email = { kind: 'email', value: 'a@b.co' } as const;

  it('prefers a whatsapp value over a phone', () => {
    expect(pickWhatsappNumber([phone, email, whatsapp])).toBe('0111');
  });

  it('falls back to a phone', () => {
    expect(pickWhatsappNumber([email, phone])).toBe('0100');
  });

  it('is null when there is neither', () => {
    expect(pickWhatsappNumber([email])).toBeNull();
    expect(pickWhatsappNumber([])).toBeNull();
  });
});
