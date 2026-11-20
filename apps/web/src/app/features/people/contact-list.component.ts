import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContactOut } from '@connections/domain-types';

import { contactHref } from './contact-links';
import { CONTACT_KIND_OPTIONS, labelKeyOf } from './person-form.model';

/** A person's contact values, each opening in the phone, WhatsApp or mail app. Never logged. */
@Component({
  selector: 'app-contact-list',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (contacts().length) {
      <ul class="contact-rows">
        @for (contact of contacts(); track contact.id) {
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

  protected kindKey(contact: ContactOut): string {
    return labelKeyOf(CONTACT_KIND_OPTIONS, contact.kind);
  }

  protected href(contact: ContactOut): string | null {
    return contactHref(contact.kind, contact.value);
  }
}
