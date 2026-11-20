import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of, throwError } from 'rxjs';

import { ApiError } from '../../core/api.client';
import { AuthService } from '../../core/auth.service';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { type PersonFormValue } from './person-form.model';
import { PersonFormComponent } from './person-form.component';

const AR_STRENGTH_HELP = 'أي حد تقدر تبعتله رسالة وهو يعرف إنت مين. اللي اتقابلتوا مرة: ضعيفة.';

describe('PersonFormComponent', () => {
  let fixture: ComponentFixture<PersonFormComponent>;
  let drafts: DraftStore;
  let submitter: jasmine.Spy<(value: PersonFormValue, idempotencyKey: string) => Observable<unknown>>;
  let saved: jasmine.Spy;

  const el = () => fixture.nativeElement as HTMLElement;
  const field = (name: string) => el().querySelector(`[formcontrolname="${name}"]`) as HTMLInputElement;
  const alertText = () => el().querySelector('[role=alert]')?.textContent ?? '';

  function setText(name: string, value: string): void {
    const input = field(name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function chooseStrength(value: 'strong' | 'normal' | 'weak'): void {
    (el().querySelector(`mat-radio-button[value="${value}"] input`) as HTMLInputElement).click();
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function create(inputs: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(PersonFormComponent);
    fixture.componentRef.setInput('draftKey', 'add-person');
    fixture.componentRef.setInput('submitter', submitter);
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.componentInstance.saved.subscribe(saved);
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    submitter = jasmine.createSpy('submitter').and.returnValue(of({ ok: true }));
    saved = jasmine.createSpy('saved');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: fakeAuthService(fakeSession('aal2')) },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    drafts = TestBed.inject(DraftStore);
  });

  afterEach(() => {
    localStorage.clear();
    delete (navigator as unknown as Record<string, unknown>)['contacts'];
  });

  it('form invalid without any name', async () => {
    create();
    chooseStrength('normal');

    await submit();

    expect(submitter).not.toHaveBeenCalled();
    expect(el().textContent).toContain('Enter a name in Arabic or English.');
  });

  it('is invalid without a strength', async () => {
    create();
    setText('nameLatin', 'Sara Ali');

    await submit();

    expect(submitter).not.toHaveBeenCalled();
    expect(el().textContent).toContain('Choose the connection strength.');
  });

  it('accepts a name in either script alone', async () => {
    create();
    setText('nameAr', 'سارة علي');
    chooseStrength('weak');

    await submit();

    expect(submitter).toHaveBeenCalledTimes(1);
    expect(submitter.calls.mostRecent().args[0].nameAr).toBe('سارة علي');
    expect(saved).toHaveBeenCalledWith({ ok: true });
  });

  it('shows the connection definition under the strength control, in Arabic', () => {
    TestBed.inject(LocaleService).setLocale('ar');
    create();

    expect(el().querySelector('.strength-help')?.textContent?.trim()).toBe(AR_STRENGTH_HELP);
  });

  it('keeps the optional fields collapsed under More details', () => {
    create();
    const more = el().querySelector('details.more') as HTMLDetailsElement;

    expect(more.open).toBeFalse();
    expect(more.querySelector('summary')?.textContent).toContain('More details');
    expect(more.contains(field('headline'))).toBeTrue();
    expect(more.contains(field('nameLatin'))).toBeFalse();
  });

  it('failed submit saves draft and shows retry', async () => {
    submitter.and.returnValue(throwError(() => new ApiError('network_error', 'down', 0)));
    create();
    setText('nameLatin', 'Sara Ali');
    chooseStrength('weak');

    await submit();

    expect(drafts.load<PersonFormValue>('add-person')?.nameLatin).toBe('Sara Ali');
    expect(drafts.load<PersonFormValue>('add-person')?.strength).toBe('weak');
    expect(alertText()).toContain('kept on this device');
    const retry = el().querySelector('button.retry') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    submitter.and.returnValue(of({ ok: true }));
    retry.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(submitter).toHaveBeenCalledTimes(2);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(drafts.load('add-person')).toBeNull();
    expect(el().querySelector('button.retry')).toBeNull();
  });

  it('saves a draft on a server error too', async () => {
    submitter.and.returnValue(throwError(() => new ApiError('internal_error', 'boom', 500)));
    create();
    setText('nameLatin', 'Sara Ali');
    chooseStrength('weak');

    await submit();

    expect(drafts.load('add-person')).not.toBeNull();
    expect(el().querySelector('button.retry')).not.toBeNull();
  });

  it('does not save a draft for a rejected request, and never shows the English API message', async () => {
    submitter.and.returnValue(
      throwError(
        () =>
          new ApiError('validation.invalid_value', 'Request validation failed.', 422, {
            field: 'connect_to_person_id',
            reason: 'person_not_found',
          }),
      ),
    );
    create();
    setText('nameLatin', 'Sara Ali');
    chooseStrength('weak');

    await submit();

    expect(drafts.load('add-person')).toBeNull();
    expect(el().querySelector('button.retry')).toBeNull();
    expect(alertText()).toContain('no longer exists');
    expect(alertText()).not.toContain('Request validation failed.');
  });

  // ApiClient sends the admin to /mfa or /login (api.client.spec); the form keeps what was typed.
  for (const [what, error] of [
    ['MFA step lapsed', new ApiError('mfa_required', 'Multi-factor authentication is required.', 403)],
    ['session ended', new ApiError('auth.unauthenticated', 'Authentication failed.', 401)],
  ] as const) {
    it(`keeps the draft when the ${what}`, async () => {
      submitter.and.returnValue(throwError(() => error));
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');

      await submit();

      expect(drafts.load<PersonFormValue>('add-person')?.nameLatin).toBe('Sara Ali');
      expect(drafts.load<PersonFormValue>('add-person')?.strength).toBe('weak');
      // Said in words too, in case nothing moves the page (a session without its person claim).
      expect(alertText()).toMatch(/session ended|authenticator app/);
    });
  }

  describe('Idempotency-Key', () => {
    const networkDown = () => throwError(() => new ApiError('network_error', 'down', 0));

    it('sends one key per submission, the same one on a retry, and keeps it in the draft', async () => {
      submitter.and.returnValue(networkDown());
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      await submit();
      const key = submitter.calls.mostRecent().args[1] as string;

      expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(drafts.load<Record<string, unknown>>('add-person')?.['idempotencyKey']).toBe(key);

      (el().querySelector('button.retry') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(submitter.calls.mostRecent().args[1]).toBe(key);
    });

    it('resubmits a restored draft with the key it was first sent with', async () => {
      submitter.and.returnValue(networkDown());
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      await submit();
      const key = submitter.calls.mostRecent().args[1];
      fixture.destroy();

      submitter.and.returnValue(of({ ok: true }));
      create();
      await submit();

      expect(submitter.calls.mostRecent().args[1]).toBe(key);
    });

    it('uses a new key for a new person', async () => {
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      await submit();
      const first = submitter.calls.mostRecent().args[1];
      fixture.destroy();

      create();
      setText('nameLatin', 'Omar');
      chooseStrength('weak');
      await submit();

      expect(submitter.calls.mostRecent().args[1]).not.toBe(first);
    });
  });

  it('keeps Save disabled after a successful save, until the page moves on', async () => {
    create();
    setText('nameLatin', 'Sara Ali');
    chooseStrength('weak');

    await submit();
    await submit();

    expect(submitter).toHaveBeenCalledTimes(1);
    expect((el().querySelector('button.save') as HTMLButtonElement).disabled).toBeTrue();
  });

  describe('text typed in a tag field but not added', () => {
    function openMore(): void {
      (el().querySelector('details.more summary') as HTMLElement).click();
      fixture.detectChanges();
    }

    function typeTag(index: number, text: string): void {
      const input = el().querySelectorAll('app-tag-input input')[index] as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('is added on save when nothing else is needed (an industry)', async () => {
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      openMore();
      typeTag(1, 'Banking');

      await submit();

      expect(submitter).toHaveBeenCalledTimes(1);
      expect(submitter.calls.mostRecent().args[0].industries).toEqual(['Banking']);
    });

    it('blocks the save when a skill has no category, naming the text', async () => {
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      openMore();
      typeTag(0, 'Python');

      await submit();

      expect(submitter).not.toHaveBeenCalled();
      expect(el().querySelector('.pending-tag')?.textContent).toContain('Python');
    });

    it('is added on save when the skill has its category', async () => {
      create();
      setText('nameLatin', 'Sara Ali');
      chooseStrength('weak');
      openMore();
      typeTag(0, 'Python');
      const category = el().querySelector('app-tag-input select.category') as HTMLSelectElement;
      category.value = 'technical';
      category.dispatchEvent(new Event('change'));

      await submit();

      expect(submitter.calls.mostRecent().args[0].skills).toEqual([
        { label: 'Python', category: 'technical', level: null },
      ]);
    });
  });

  describe('a draft that belongs to someone (the contributor page)', () => {
    async function failOnce(owner: string): Promise<void> {
      submitter.and.returnValue(throwError(() => new ApiError('network_error', 'down', 0)));
      create({ draftKey: 'contribute', draftOwner: owner, draftMaxAgeDays: 7, contributor: true });
      setText('nameLatin', 'Hoda');
      chooseStrength('weak');
      await submit();
      fixture.destroy();
    }

    it('records who it belongs to and when it was saved', async () => {
      await failOnce('Sami');

      const stored = drafts.load<Record<string, unknown>>('contribute');
      expect(stored?.['draftOwner']).toBe('Sami');
      expect(Date.now() - Date.parse(stored?.['savedAt'] as string)).toBeLessThan(60_000);
    });

    it('is restored for the same contributor', async () => {
      await failOnce('Sami');

      create({ draftKey: 'contribute', draftOwner: 'Sami', draftMaxAgeDays: 7, contributor: true });

      expect(field('nameLatin').value).toBe('Hoda');
    });

    it('is dropped for another contributor', async () => {
      await failOnce('Sami');

      create({ draftKey: 'contribute', draftOwner: 'Karim', draftMaxAgeDays: 7, contributor: true });

      expect(field('nameLatin').value).toBe('');
      expect(drafts.load('contribute')).toBeNull();
    });

    it('is dropped once it is older than its maximum age', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
      drafts.save('contribute', { nameLatin: 'Hoda', draftOwner: 'Sami', savedAt: eightDaysAgo });

      create({ draftKey: 'contribute', draftOwner: 'Sami', draftMaxAgeDays: 7, contributor: true });

      expect(field('nameLatin').value).toBe('');
      expect(drafts.load('contribute')).toBeNull();
    });
  });

  it('restores the typed input when the page is reopened after an MFA step', async () => {
    submitter.and.returnValue(
      throwError(() => new ApiError('mfa_required', 'Multi-factor authentication is required.', 403)),
    );
    create();
    setText('nameLatin', 'Sara Ali');
    chooseStrength('weak');
    await submit();
    fixture.destroy();

    create();

    expect(field('nameLatin').value).toBe('Sara Ali');
    expect(el().querySelector('.draft-note')).not.toBeNull();
  });

  it('restores a saved draft, and discarding it clears the form', async () => {
    drafts.save('add-person', {
      nameLatin: 'Sara Ali',
      strength: 'weak',
      contacts: [{ kind: 'phone', value: '0101' }],
      skills: [{ label: 'Python', category: 'technical', level: 'good' }],
    });
    create();

    expect(field('nameLatin').value).toBe('Sara Ali');
    expect((el().querySelector('mat-radio-button[value="weak"] input') as HTMLInputElement).checked).toBeTrue();
    expect((el().querySelector('details.more') as HTMLDetailsElement).open).toBeTrue();
    expect((el().querySelector('.contacts input.contact-value') as HTMLInputElement).value).toBe('0101');
    expect(el().textContent).toContain('Python');
    expect(el().querySelector('.draft-note')).not.toBeNull();

    (el().querySelector('button.discard') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(field('nameLatin').value).toBe('');
    expect(drafts.load('add-person')).toBeNull();
    expect(el().querySelector('.draft-note')).toBeNull();
  });

  it('does not save a draft on every keystroke', () => {
    create();
    setText('nameLatin', 'Sara');

    expect(drafts.load('add-person')).toBeNull();
  });

  it('hides the contact picker button when the browser lacks the Contact Picker API', () => {
    create();

    expect(el().querySelector('button.pick-contact')).toBeNull();
  });

  it('fills name, phone and email from the picked contact', async () => {
    Object.defineProperty(navigator, 'contacts', {
      configurable: true,
      value: {
        select: () => Promise.resolve([{ name: ['Sara Ali'], tel: ['0101 234 5678'], email: ['s@example.com'] }]),
      },
    });
    create();

    (el().querySelector('button.pick-contact') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    chooseStrength('weak');
    await submit();

    const value = submitter.calls.mostRecent().args[0];
    expect(value.nameLatin).toBe('Sara Ali');
    expect(value.contacts).toEqual([
      { kind: 'phone', value: '0101 234 5678' },
      { kind: 'email', value: 's@example.com' },
    ]);
  });

  it('in edit mode starts from the person and asks for no strength', async () => {
    create({
      mode: 'edit',
      draftKey: 'edit-person:7',
      initial: { nameAr: '', nameLatin: 'Omar', city: 'Cairo' },
    });

    expect(field('nameLatin').value).toBe('Omar');
    expect(el().querySelector('mat-radio-button')).toBeNull();
    expect((el().querySelector('details.more') as HTMLDetailsElement).open).toBeTrue();

    await submit();

    expect(submitter).toHaveBeenCalledTimes(1);
  });

  describe('contributor mode', () => {
    it('hides the admin notes, the connection note and the Connected to picker, and keeps the strength', () => {
      create({ contributor: true, draftKey: 'contribute' });

      expect(field('adminNotes')).toBeNull();
      expect(field('connectionNote')).toBeNull();
      expect(el().querySelector('app-person-picker')).toBeNull();
      expect(el().querySelector('mat-radio-group')).not.toBeNull();
      expect(el().querySelector('.strength-help')?.textContent).toContain('Anyone you could message');
      expect(el().querySelector('legend')?.textContent).not.toContain('Private notes');
    });

    it('still requires a strength', async () => {
      create({ contributor: true, draftKey: 'contribute' });
      setText('nameLatin', 'Sara Ali');

      await submit();

      expect(submitter).not.toHaveBeenCalled();
      expect(el().textContent).toContain('Choose the connection strength.');
    });

    it('shows the admin fields by default', () => {
      create();

      expect(field('adminNotes')).not.toBeNull();
      expect(el().querySelector('app-person-picker')).not.toBeNull();
    });

    it('takes tag suggestions from the given source instead of the admin /tags', async () => {
      const source = jasmine.createSpy('suggestSource').and.returnValue(of([{ label: 'Design', category: null }]));
      create({ contributor: true, draftKey: 'contribute', suggestSource: source });
      (el().querySelector('details.more summary') as HTMLElement).click();
      fixture.detectChanges();

      const input = el().querySelector('app-tag-input input') as HTMLInputElement;
      input.value = 'des';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(source).toHaveBeenCalledWith('skill', 'des');
    });
  });
});
