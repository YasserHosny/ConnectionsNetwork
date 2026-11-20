import { containsContactValue } from './contact-value';

describe('containsContactValue', () => {
  it('finds a phone number written any way, alone or inside other text', () => {
    for (const text of [
      '01012345678',
      'Sara 01012345678',
      '+20 10 1234 5678',
      '(010) 1234-5678',
      '010.1234.5678',
      '٠١٠١٢٣٤٥٦٧٨',
      'call ۰۱۰۱۲۳۴۵۶۷۸ now',
      '1234567',
    ]) {
      expect(containsContactValue(text)).withContext(text).toBeTrue();
    }
  });

  it('finds an email address, alone or inside other text', () => {
    expect(containsContactValue('sara@example.com')).toBeTrue();
    expect(containsContactValue('mail Sara at sara@example.com please')).toBeTrue();
  });

  it('leaves names, skills, years and short numbers alone', () => {
    for (const text of ['Sara Mahmoud', 'سارة', 'marketing 2024', 'C++ 11', '123456', '@sara', 'Cairo 12 3']) {
      expect(containsContactValue(text)).withContext(text).toBeFalse();
    }
  });
});
