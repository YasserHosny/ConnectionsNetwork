import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { CreatePersonResponse, DuplicateCheckRequest, DuplicateHint } from '@connections/domain-types';
import { type Observable, catchError, of, switchMap, throwError } from 'rxjs';

import { ApiClient, ApiError, toApiError } from '../../core/api.client';
import { AuthService } from '../../core/auth.service';
import { IsolatePipe } from '../../core/bidi';
import { MATCHED_ON_KEYS, type PersonFormValue, toNewPersonRequest } from './person-form.model';
import { PersonFormComponent } from './person-form.component';

/**
 * Quick add (spec 8.1, 8.3): name and connection strength are required; saving creates the person
 * and a connection to the admin, or to whoever "Connected to" names.
 *
 * Before saving, typed numbers, emails and links are checked against the network: when someone
 * already has one, nothing is saved yet and the page lists them; pressing Save again with the same
 * values saves anyway. A check that fails never blocks the save. When the create response still
 * reports possible duplicates the page stays, listing them; otherwise it goes to the new person,
 * which then offers to add another.
 */
@Component({
  selector: 'app-add-person-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe, IsolatePipe, PersonFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.add.title' | translate }}</h1>

    @if (precheckHints().length && !created()) {
      <section class="precheck" role="alert">
        <h2>{{ 'person.precheck.title' | translate }}</h2>
        <p>{{ 'person.precheck.intro' | translate }}</p>
        <ul>
          @for (hint of precheckHints(); track hint.person_id) {
            <li>
              <a [routerLink]="['/people', hint.person_id]">{{ hint.display_name }}</a>
              <span class="matched-on">{{ matchedOnKey(hint.matched_on) | translate }}</span>
            </li>
          }
        </ul>
      </section>
    }

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
          <button mat-stroked-button type="button" class="add-another" (click)="startAnother()">
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
    .precheck {
      max-inline-size: 640px;
      margin-block-end: 16px;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }
    .precheck h2 {
      margin-block: 0 4px;
      font-size: 1rem;
    }
    .precheck ul,
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
  /** People who already have a typed number, email or link: shown before anything is saved. */
  protected readonly precheckHints = signal<DuplicateHint[]>([]);
  /** The values those hints were shown for: Save with the same values again means "save anyway". */
  private warnedFor: string | null = null;

  protected readonly submit = (
    value: PersonFormValue,
    idempotencyKey: string,
    retry: boolean,
  ): Observable<CreatePersonResponse> => {
    // The admin's own person comes from the session's `person_id` claim.
    const adminPersonId = this.auth.personId();
    if (!adminPersonId) {
      return throwError(() => new ApiError('no_person_claim', 'No signed-in person.', 401));
    }
    const request = toNewPersonRequest(value, adminPersonId);
    const create = () => this.api.post<CreatePersonResponse>('/people', request, { idempotencyKey });
    const typed: DuplicateCheckRequest = {
      contacts: request.person.contacts ?? [],
      social_links: request.person.social_links ?? [],
    };
    const signature = JSON.stringify(typed);
    // A retry resends a create that may already exist under its key: checking again would only find
    // that person. Nothing typed to check, or the same values already warned about: save.
    if (retry || (!typed.contacts.length && !typed.social_links.length) || signature === this.warnedFor) {
      return create();
    }
    return this.api.post<DuplicateHint[]>('/duplicates/check', typed).pipe(
      // A check that fails never blocks the save, except when the session ended or its MFA step
      // lapsed: then the form must keep the entry while ApiClient sends the admin to sign in.
      catchError((failure: unknown) => {
        const error = toApiError(failure);
        if (error.status === 401 || error.code === 'mfa_required') return throwError(() => failure);
        return of<DuplicateHint[]>([]);
      }),
      switchMap((hints) => {
        this.precheckHints.set(hints);
        if (!hints.length) return create();
        this.warnedFor = signature;
        return throwError(() => new ApiError('possible_duplicates', 'Possible duplicates', 409));
      }),
    );
  };

  /** A fresh form for the next person: the last one's warning and its confirmation do not carry over. */
  protected startAnother(): void {
    this.created.set(null);
    this.precheckHints.set([]);
    this.warnedFor = null;
  }

  protected matchedOnKey(matchedOn: string): string {
    return MATCHED_ON_KEYS[matchedOn] ?? 'person.duplicates.matchedOn.phone';
  }

  protected onSaved(result: unknown): void {
    const response = result as CreatePersonResponse;
    if (response.possible_duplicates.length) {
      this.created.set(response);
    } else {
      void this.router.navigateByUrl(`/people/${encodeURIComponent(response.person.id)}`, {
        state: { justAdded: true },
      });
    }
  }
}
