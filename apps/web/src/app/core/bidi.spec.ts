import { IsolatePipe, isolate } from './bidi';

describe('isolate', () => {
  it('wraps a name in first-strong and pop directional isolates', () => {
    expect(isolate('سارة')).toBe('⁨سارة⁩');
    expect(isolate('Sara Mahmoud')).toBe('⁨Sara Mahmoud⁩');
  });

  it('leaves an empty name empty', () => {
    expect(isolate('')).toBe('');
  });

  it('is available as a pipe, null-safe', () => {
    const pipe = new IsolatePipe();
    expect(pipe.transform('Sara')).toBe('⁨Sara⁩');
    expect(pipe.transform(null)).toBe('');
  });
});
