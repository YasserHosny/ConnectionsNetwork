import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { ContactOut } from '@connections/domain-types';

import { LocaleService } from '../../core/locale.service';
import { loadCatalogues } from '../../testing/test-helpers';
import { ContactListComponent } from './contact-list.component';

describe('ContactListComponent', () => {
  function render(contacts: Omit<ContactOut, 'id' | 'added_by_person_id'>[]): string[] {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    const fixture = TestBed.createComponent(ContactListComponent);
    fixture.componentRef.setInput(
      'contacts',
      contacts.map((c, i) => ({ ...c, id: `c${i}`, added_by_person_id: null })),
    );
    fixture.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('li');
    return Array.from(rows).map(
      (li) => `${li.querySelector('.kind')?.textContent?.trim()} ${li.querySelector('.value')?.textContent?.trim()}`,
    );
  }

  // After a merge, each contributor of the same value keeps a row (attribution), but the admin
  // reads one person's details: the same value written another way is shown once.
  it('shows an email that differs only in case once, as first written', () => {
    expect(
      render([
        { kind: 'email', value: 'qa-test-alpha@example.com' },
        { kind: 'email', value: 'QA-Test-Alpha@Example.com' },
      ]),
    ).toEqual(['Email qa-test-alpha@example.com']);
  });

  it('shows a number written two ways once, per kind', () => {
    expect(
      render([
        { kind: 'phone', value: '0101 234 5678' },
        { kind: 'phone', value: '+20 10 1234 5678' },
        { kind: 'whatsapp', value: '01012345678' },
      ]),
    ).toEqual(['Phone 0101 234 5678', 'WhatsApp 01012345678']);
  });

  it('keeps different values apart', () => {
    expect(
      render([
        { kind: 'email', value: 'a@example.com' },
        { kind: 'email', value: 'b@example.com' },
      ]).length,
    ).toBe(2);
  });
});
