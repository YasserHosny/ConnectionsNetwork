import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { PersonOut, SearchResult } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { ResultCardComponent } from './result-card.component';

const FAR: SearchResult = {
  person_id: 'sara',
  display_name: 'Sara Mahmoud',
  profession: 'Digital Marketing',
  headline: null,
  city: 'Cairo',
  matched_skills: [
    { label: 'SEO', level: 'expert' },
    { label: 'Meta Ads', level: null },
  ],
  available_for: ['freelance'],
  last_confirmed_at: '2026-08-20T10:00:00Z',
  is_stale: false,
  path: [
    { person_id: 'me', display_name: 'Me' },
    { person_id: 'ahmed', display_name: 'Ahmed' },
    { person_id: 'karim', display_name: 'Karim' },
    { person_id: 'sara', display_name: 'Sara Mahmoud' },
  ],
  cost: 5,
  steps: 3,
};

const person = (id: string, contacts: { kind: string; value: string }[]): PersonOut =>
  ({
    id,
    display_name: id,
    contacts: contacts.map((c, i) => ({ id: `c${i}`, added_by_person_id: null, ...c })),
  }) as unknown as PersonOut;

describe('ResultCardComponent', () => {
  let fixture: ComponentFixture<ResultCardComponent>;
  let http: HttpTestingController;
  let navigate: jasmine.Spy;
  let open: jasmine.Spy;

  const el = () => fixture.nativeElement as HTMLElement;
  const button = (cls: string) => el().querySelector(`button.${cls}`) as HTMLButtonElement;

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function show(result: SearchResult): void {
    fixture = TestBed.createComponent(ResultCardComponent);
    fixture.componentRef.setInput('result', result);
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
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
    http = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    open = spyOn(TestBed.inject(DOCUMENT).defaultView as Window, 'open').and.returnValue({} as Window);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('shows the name, profession, city, matched skills with levels and what the person is available for', () => {
    show(FAR);

    expect(el().querySelector('a.name')?.textContent).toContain('Sara Mahmoud');
    expect(el().querySelector('a.name')?.getAttribute('href')).toBe('/people/sara');
    expect(el().textContent).toContain('Digital Marketing');
    expect(el().textContent).toContain('Cairo');
    const skills = Array.from(el().querySelectorAll('li.skill')).map((s) => s.textContent?.trim());
    expect(skills).toEqual(['SEO (Expert)', 'Meta Ads']);
    expect(el().querySelector('.available')?.textContent).toContain('Takes freelance work');
  });

  it('renders a stale badge only when the person is stale', () => {
    show(FAR);
    expect(el().querySelector('.stale-badge')).toBeNull();

    show({ ...FAR, is_stale: true });
    expect(el().querySelector('.stale-badge')?.textContent).toContain('Not confirmed for over a year');
  });

  it('shows the path from you and its steps', () => {
    show(FAR);

    const names = Array.from(el().querySelectorAll('.path-line li')).map((li) => li.querySelector('a')?.textContent ?? li.textContent);
    expect(names).toEqual(['You', 'Ahmed', 'Karim', 'Sara Mahmoud']);
    expect(el().querySelectorAll('.path-line .sep').length).toBe(3);
    expect(el().querySelector('.steps')?.textContent).toContain('3');
  });

  // A name mixing Arabic and Latin ("اختبار QA TEST ألف") must read in its own direction in either UI.
  it('lets every name set its own direction', () => {
    show(FAR);

    const names = [el().querySelector('a.name'), ...Array.from(el().querySelectorAll('.path-line a'))];
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(name?.getAttribute('dir')).withContext(name?.textContent ?? '').toBe('auto');
  });

  it('shows "not connected to you" instead of a path for an unreachable person, with no intro', () => {
    show({ ...FAR, path: [], cost: null, steps: 0 });

    expect(el().querySelector('.not-connected')?.textContent).toContain('Not connected to you');
    expect(el().querySelector('.path-line')).toBeNull();
    expect(button('ask-intro')).toBeNull();
    expect(button('contact-direct')).not.toBeNull();
  });

  it('shows only "Contact directly" for a direct contact', () => {
    show({ ...FAR, path: FAR.path.filter((_, i) => i === 0 || i === 3), cost: 1, steps: 1 });

    expect(button('ask-intro')).toBeNull();
    expect(button('contact-direct')).not.toBeNull();
  });

  describe('ask for an intro', () => {
    it('names the first hop on the button', () => {
      show(FAR);

      expect(button('ask-intro').textContent).toContain('Ask \u2068Ahmed\u2069 for an intro');
    });

    it('opens WhatsApp with the message when the first hop has a whatsapp number, falling back to phone', async () => {
      const opened = { opener: {} } as unknown as Window;
      open.and.returnValue(opened);
      show(FAR);
      button('ask-intro').click();
      http
        .expectOne('/api/v1/people/ahmed')
        .flush(person('ahmed', [{ kind: 'phone', value: '010 1234 5678' }, { kind: 'whatsapp', value: '+20 111 222 3333' }]));
      await settle();

      const message =
        'Hi \u2068Ahmed\u2069, do you know someone who can introduce me to \u2068Sara Mahmoud\u2069? \u2068Karim\u2069 knows \u2068Sara Mahmoud\u2069.';
      expect(open).toHaveBeenCalledOnceWith(
        `https://wa.me/201112223333?text=${encodeURIComponent(message)}`,
        '_blank',
      );
      // The opened window must not be able to reach back to this one.
      expect(opened.opener).toBeNull();
    });

    it('uses the phone when there is no whatsapp value', async () => {
      show(FAR);
      button('ask-intro').click();
      http.expectOne('/api/v1/people/ahmed').flush(person('ahmed', [{ kind: 'phone', value: '01012345678' }]));
      await settle();

      expect(open.calls.mostRecent().args[0]).toContain('https://wa.me/201012345678?text=');
    });

    it('copies the message when the first hop has no number', async () => {
      const write = spyOn(navigator.clipboard, 'writeText').and.resolveTo();
      show(FAR);
      button('ask-intro').click();
      http.expectOne('/api/v1/people/ahmed').flush(person('ahmed', [{ kind: 'email', value: 'a@b.co' }]));
      await settle();

      expect(open).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledOnceWith(
        'Hi \u2068Ahmed\u2069, do you know someone who can introduce me to \u2068Sara Mahmoud\u2069? \u2068Karim\u2069 knows \u2068Sara Mahmoud\u2069.',
      );
      expect(el().querySelector('.intro-status')?.textContent).toContain('The message was copied');
    });

    it('shows the text to copy by hand when copying fails', async () => {
      spyOn(navigator.clipboard, 'writeText').and.rejectWith(new Error('denied'));
      show(FAR);
      button('ask-intro').click();
      http.expectOne('/api/v1/people/ahmed').flush(person('ahmed', []));
      await settle();

      expect(el().querySelector('.intro-status')?.textContent).toContain('Could not copy automatically');
      expect((el().querySelector('textarea.intro-text') as HTMLTextAreaElement).value).toContain('Hi \u2068Ahmed\u2069');
    });

    it('offers an Open WhatsApp link when the browser blocks the window', async () => {
      open.and.returnValue(null);
      show(FAR);
      button('ask-intro').click();
      http.expectOne('/api/v1/people/ahmed').flush(person('ahmed', [{ kind: 'whatsapp', value: '01112223333' }]));
      await settle();

      const link = el().querySelector('a.open-whatsapp') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toContain('https://wa.me/201112223333?text=');
    });

    it('writes the message in the language of the app', async () => {
      TestBed.inject(LocaleService).setLocale('ar');
      spyOn(navigator.clipboard, 'writeText').and.resolveTo();
      show(FAR);
      button('ask-intro').click();
      http.expectOne('/api/v1/people/ahmed').flush(person('ahmed', []));
      await settle();

      expect((navigator.clipboard.writeText as jasmine.Spy).calls.mostRecent().args[0]).toContain('أهلًا \u2068Ahmed\u2069');
    });

    it('goes to /mfa when the MFA step has lapsed', async () => {
      show(FAR);
      button('ask-intro').click();
      http
        .expectOne('/api/v1/people/ahmed')
        .flush(
          { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
          { status: 403, statusText: 'Forbidden' },
        );
      await settle();

      expect(navigate).toHaveBeenCalledWith('/mfa');
    });

    it('says what went wrong without showing the API text', async () => {
      show(FAR);
      button('ask-intro').click();
      http
        .expectOne('/api/v1/people/ahmed')
        .flush(
          { code: 'internal_error', message: 'Boom from the server', details: null, trace_id: 't' },
          { status: 500, statusText: 'Server Error' },
        );
      await settle();

      const alert = el().querySelector('[role=alert]');
      expect(alert?.textContent).toContain('Could not reach the server');
      expect(el().textContent).not.toContain('Boom');
    });
  });

  describe('contact directly', () => {
    it('fetches the person on demand and lists their contacts, then hides them again', async () => {
      show(FAR);
      expect(el().querySelector('.contacts')).toBeNull();

      button('contact-direct').click();
      http
        .expectOne('/api/v1/people/sara')
        .flush(person('sara', [{ kind: 'phone', value: '01012345678' }, { kind: 'email', value: 'sara@example.com' }]));
      await settle();

      const rows = Array.from(el().querySelectorAll('.contacts li')).map((r) => [
        r.querySelector('.kind')?.textContent,
        r.querySelector('.value')?.textContent,
      ]);
      expect(rows).toEqual([
        ['Phone', '01012345678'],
        ['Email', 'sara@example.com'],
      ]);
      expect(el().querySelector('.contacts a[href="tel:+201012345678"]')).not.toBeNull();
      expect(el().querySelector('.contacts a[href="mailto:sara@example.com"]')).not.toBeNull();

      button('contact-direct').click();
      fixture.detectChanges();
      expect(el().querySelector('.contacts')).toBeNull();

      // Shown again from what was already fetched.
      button('contact-direct').click();
      fixture.detectChanges();
      expect(el().querySelectorAll('.contacts li').length).toBe(2);
    });

    it('says when no contact details are saved', async () => {
      show(FAR);
      button('contact-direct').click();
      http.expectOne('/api/v1/people/sara').flush(person('sara', []));
      await settle();

      expect(el().querySelector('.contacts')?.textContent).toContain('No contact details are saved');
    });

    it('shows a translated error when the person cannot be loaded', async () => {
      show(FAR);
      button('contact-direct').click();
      http.expectOne('/api/v1/people/sara').error(new ProgressEvent('error'));
      await settle();

      expect(el().querySelector('[role=alert]')?.textContent).toContain('Could not reach the server');
    });
  });
});
