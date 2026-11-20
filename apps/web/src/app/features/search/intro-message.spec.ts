import { arCatalog } from '@connections/i18n';

import { buildIntroMessage, pickWhatsappNumber, whatsappUrl } from './intro-message';

const node = (display_name: string) => ({ display_name });

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
      'Hi Ahmed, do you know someone who can introduce me to Sara Mahmoud? Karim knows Sara Mahmoud.',
    );
  });

  it('for a 3-node path asks the first hop, who already knows the target, without the "knows" line', () => {
    const text = buildIntroMessage('en', [node('Me'), node('Ahmed'), node('Sara Mahmoud')]);

    expect(text).toBe('Hi Ahmed, do you know someone who can introduce me to Sara Mahmoud?');
  });

  it('for a 2-node path (direct) is not generated', () => {
    expect(buildIntroMessage('ar', [node('أنا'), node('سارة')])).toBe('');
    expect(buildIntroMessage('en', [node('Me')])).toBe('');
    expect(buildIntroMessage('en', [])).toBe('');
  });

  it('does not expand placeholders that appear inside a name', () => {
    const text = buildIntroMessage('en', [node('Me'), node('{{target}}'), node('Sara')]);

    expect(text).toBe('Hi {{target}}, do you know someone who can introduce me to Sara?');
  });
});

describe('whatsappUrl', () => {
  it('strips non-digits from the number and encodes the text', () => {
    expect(whatsappUrl('+20 10 1234-5678', 'Hi Ahmed & co?')).toBe(
      'https://wa.me/201012345678?text=Hi%20Ahmed%20%26%20co%3F',
    );
  });

  it('turns a local Egyptian number into an international one (default country +20)', () => {
    expect(whatsappUrl('010 1234 5678', 'x')).toBe('https://wa.me/201012345678?text=x');
  });

  it('drops a 00 international prefix', () => {
    expect(whatsappUrl('00201012345678', 'x')).toBe('https://wa.me/201012345678?text=x');
  });

  it('reads Arabic-Indic digits', () => {
    expect(whatsappUrl('٠١٠١٢٣٤٥٦٧٨', 'x')).toBe('https://wa.me/201012345678?text=x');
  });

  it('leaves the text off when there is none', () => {
    expect(whatsappUrl('+201012345678', '')).toBe('https://wa.me/201012345678');
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
