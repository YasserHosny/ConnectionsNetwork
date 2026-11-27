import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContactOut } from '@connections/domain-types';

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

  /** One row per value, in first-written order; of two ways to write it, the one that opens wins. */
  protected readonly shown = computed(() => {
    const rows = new Map<string, ContactOut>();
    for (const contact of this.contacts()) {
      const key = `${contact.kind}:${sameValueKey(contact)}`;
      const kept = rows.get(key);
      if (!kept || (!this.href(kept) && this.href(contact))) rows.set(key, contact);
    }
    return [...rows.values()];
  });

  protected kindKey(contact: ContactOut): string {
    return labelKeyOf(CONTACT_KIND_OPTIONS, contact.kind);
  }

  protected href(contact: ContactOut): string | null {
    return contactHref(contact.kind, contact.value);
  }
}

/** What makes two values of one kind the same: the server's normal forms (duplicates, merge). */
function sameValueKey(contact: ContactOut): string {
  const value = contact.value.trim();
  return contact.kind === 'email' ? value.toLowerCase() : normalizePhone(value);
}

/**
 * `public.normalize_phone` (migration 20261119000001), so a number the server treats as one is shown
 * once: 00 is +, a leading 0 is +20, 20 plus ten digits gets +, ten or more digits gets +20, and
 * Arabic-Indic digits are read as 0-9.
 */
function normalizePhone(value: string): string {
  const ascii = value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = ascii.replace(/[^0-9]/g, '');
  if (/^0*$/.test(digits)) return value;
  if (/^[^0-9+]*\+/.test(ascii)) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+20${digits.slice(1)}`;
  if (/^20[0-9]{10}$/.test(digits)) return `+${digits}`;
  if (digits.length >= 10) return `+20${digits}`;
  return digits;
}
