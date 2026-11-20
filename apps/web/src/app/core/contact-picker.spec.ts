import { isContactPickerSupported, pickContact } from './contact-picker';

interface Pick {
  name?: string[];
  tel?: string[];
  email?: string[];
}

function setContacts(select: (() => Promise<Pick[]>) | null): void {
  if (select) {
    Object.defineProperty(navigator, 'contacts', { value: { select }, configurable: true });
  } else {
    delete (navigator as unknown as Record<string, unknown>)['contacts'];
  }
}

describe('contact picker', () => {
  afterEach(() => setContacts(null));

  it('is unsupported where the browser has no Contact Picker API', () => {
    setContacts(null);

    expect(isContactPickerSupported()).toBeFalse();
  });

  it('resolves null without asking when unsupported', async () => {
    setContacts(null);

    expect(await pickContact()).toBeNull();
  });

  it('returns the name, first phone and first email of the picked contact', async () => {
    const select = jasmine
      .createSpy('select')
      .and.resolveTo([{ name: ['Sara Ali'], tel: ['010 1234 5678', '02 555'], email: ['sara@example.com'] }]);
    setContacts(select);

    expect(isContactPickerSupported()).toBeTrue();
    expect(await pickContact()).toEqual({
      name: 'Sara Ali',
      tel: '010 1234 5678',
      email: 'sara@example.com',
    });
    expect(select).toHaveBeenCalledWith(['name', 'tel', 'email'], { multiple: false });
  });

  it('leaves out what the contact does not have', async () => {
    setContacts(() => Promise.resolve([{ name: ['Omar'], tel: [] }]));

    expect(await pickContact()).toEqual({ name: 'Omar' });
  });

  it('resolves null when nothing is picked or the picker fails', async () => {
    setContacts(() => Promise.resolve([]));
    expect(await pickContact()).toBeNull();

    setContacts(() => Promise.reject(new DOMException('cancelled', 'AbortError')));
    expect(await pickContact()).toBeNull();
  });
});
