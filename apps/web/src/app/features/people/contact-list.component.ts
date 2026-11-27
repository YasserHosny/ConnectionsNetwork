import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContactOut } from '@connections/domain-types';

import { phoneDigits } from '../search/intro-message';
import { contactHref } from './contact-links';
import { CONTACT_KIND_OPTIONS, labelKeyOf } from './person-form.model';

/**
 * A person's contact values, each opening in the phone, WhatsApp or mail app. Never logged.
 *
 * The same value written another way (an email in other case, a number with or without +20) is
 * shown once, as first written: after a merge each contributor keeps their own row for attribution,
 * but the admin is reading one person's details.
 */
@Component({
  selector: 'app-contact-list',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown().length) {
      <ul class="contact-rows">
        @for (contact of shown(); track contact.id) {
          <li>
            <span class="kind">{{ kindKey(contact) | translate }}</span>
            <a class="value" dir="ltr" [href]="href(contact)">{{ contact.value }}</a>
          </li>
        }
      </ul>
    } @else {
      <p class="none">{{ 'person.view.noContacts' | translate }}</p>
    }
  `,
  styles: `
    .contact-rows {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
    }
    .kind,
    .none {
      color: var(--mat-sys-on-surface-variant);
    }
    .none {
      margin: 0;
    }
  `,
})
export class ContactListComponent {
  readonly contacts = input.required<readonly ContactOut[]>();

  protected readonly shown = computed(() => {
    const seen = new Set<string>();
    return this.contacts().filter((contact) => {
      const key = `${contact.kind}:${sameValueKey(contact)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  protected kindKey(contact: ContactOut): string {
    return labelKeyOf(CONTACT_KIND_OPTIONS, contact.kind);
  }

  protected href(contact: ContactOut): string | null {
    return contactHref(contact.kind, contact.value);
  }
}

/** What makes two values of one kind the same: case for an email, the dialled number for a phone. */
function sameValueKey(contact: ContactOut): string {
  const value = contact.value.trim();
  return contact.kind === 'email' ? value.toLowerCase() : (phoneDigits(value) ?? value);
}
