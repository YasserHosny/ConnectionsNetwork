import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { CreatePersonResponse } from '@connections/domain-types';
import { type Observable, throwError } from 'rxjs';

import { ApiClient, ApiError } from '../../core/api.client';
import { AuthService } from '../../core/auth.service';
import { IsolatePipe } from '../../core/bidi';
import { MATCHED_ON_KEYS, type PersonFormValue, toNewPersonRequest } from './person-form.model';
import { PersonFormComponent } from './person-form.component';

/**
 * Quick add (spec 8.1, 8.3): name and connection strength are required; saving creates the person
 * and a connection to the admin, or to whoever "Connected to" names.
 *
 * When the API reports possible duplicates the page stays, listing them with links, so the admin
 * sees them before leaving; otherwise it goes straight to the new person.
 */
@Component({
  selector: 'app-add-person-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe, IsolatePipe, PersonFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.add.title' | translate }}</h1>

    @if (created(); as result) {
      <section class="saved">
        <p role="status">{{ 'person.saved' | translate: { name: (result.person.display_name | isolate) } }}</p>

        <div class="duplicates">
          <h2>{{ 'person.duplicates.title' | translate }}</h2>
          <p>{{ 'person.duplicates.intro' | translate }}</p>
          <ul>
            @for (hint of result.possible_duplicates; track hint.person_id) {
              <li>
                <a [routerLink]="['/people', hint.person_id]">{{ hint.display_name }}</a>
                <span class="matched-on">{{ matchedOnKey(hint.matched_on) | translate }}</span>
              </li>
            }
          </ul>
        </div>

        <div class="actions">
          <a mat-flat-button class="open-person" [routerLink]="['/people', result.person.id]">
            {{ 'person.duplicates.openPerson' | translate }}
          </a>
          <button mat-stroked-button type="button" (click)="created.set(null)">
            {{ 'person.duplicates.addAnother' | translate }}
          </button>
        </div>
      </section>
    } @else {
      <app-person-form draftKey="add-person" [submitter]="submit" (saved)="onSaved($event)" />
    }
  `,
  styles: `
    .saved {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-inline-size: 640px;
    }
    .duplicates ul {
      margin: 0;
      padding-inline-start: 20px;
    }
    .matched-on {
      margin-inline-start: 8px;
      color: var(--mat-sys-on-surface-variant);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
  `,
})
export class AddPersonPage {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly created = signal<CreatePersonResponse | null>(null);

  protected readonly submit = (
    value: PersonFormValue,
    idempotencyKey: string,
  ): Observable<CreatePersonResponse> => {
    // The admin's own person comes from the session's `person_id` claim.
    const adminPersonId = this.auth.personId();
    if (!adminPersonId) {
      return throwError(() => new ApiError('no_person_claim', 'No signed-in person.', 401));
    }
    return this.api.post<CreatePersonResponse>('/people', toNewPersonRequest(value, adminPersonId), {
      idempotencyKey,
    });
  };

  protected matchedOnKey(matchedOn: string): string {
    return MATCHED_ON_KEYS[matchedOn] ?? 'person.duplicates.matchedOn.phone';
  }

  protected onSaved(result: unknown): void {
    const response = result as CreatePersonResponse;
    if (response.possible_duplicates.length) {
      this.created.set(response);
    } else {
      void this.router.navigateByUrl(`/people/${encodeURIComponent(response.person.id)}`);
    }
  }
}
