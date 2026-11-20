import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { CreateLinkRequest, IssuedLink, ReviewPerson } from '@connections/domain-types';

import { ApiClient, toApiError } from '../../core/api.client';
import { LocaleService } from '../../core/locale.service';
import { relativeTime } from '../../core/relative-time';
import { LinkIssuedDialog, type LinkIssuedDialogData } from '../links/link-issued.dialog';
import { actionErrorKey, isMfaRequired } from '../people/person-errors';
import { REVIEW_LIST_STYLES } from './review-list.styles';

type LoadState = 'loading' | 'ready' | 'failed';
type Action = 'confirm' | 'link';

/**
 * Stale profiles (spec 8.8): everyone last confirmed over 12 months ago. Confirm that the details
 * are still right, edit them, or create a contributor link for the person to update their own
 * profile and share it on WhatsApp (or copy it) from the dialog that shows the link once.
 */
@Component({
  selector: 'app-stale-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="intro">{{ 'review.stale.intro' | translate }}</p>

    @switch (state()) {
      @case ('loading') {
        <p role="status">{{ 'common.loading' | translate }}</p>
      }
      @case ('failed') {
        <p class="load-error error" role="alert">{{ 'review.loadFailed' | translate }}</p>
        <button mat-stroked-button type="button" class="retry" (click)="load()">
          {{ 'common.retry' | translate }}
        </button>
      }
      @case ('ready') {
        @if (confirmedName(); as name) {
          <p class="status" role="status">{{ 'review.stale.confirmed' | translate: { name } }}</p>
        }
        @if (error(); as key) {
          <p class="error" role="alert">{{ key | translate }}</p>
        }

        @if (people().length === 0) {
          <p class="empty">{{ 'review.stale.empty' | translate }}</p>
        }

        <ul class="people">
          @for (person of people(); track person.person_id) {
            <li class="person">
              <div class="info">
                <a class="name" [routerLink]="['/people', person.person_id]">{{ person.display_name }}</a>
                @if (detail(person); as text) {
                  <span class="detail">{{ text }}</span>
                }
                <span class="detail">{{ 'person.lastConfirmed' | translate: { when: confirmedAgo(person) } }}</span>
              </div>
              <div class="actions">
                <button mat-flat-button type="button" class="confirm" [disabled]="busy() !== null" (click)="confirm(person)">
                  {{ (isBusy(person, 'confirm') ? 'review.stale.confirming' : 'review.stale.confirm') | translate }}
                </button>
                <a mat-stroked-button class="edit" [routerLink]="['/people', person.person_id, 'edit']">
                  {{ 'review.stale.edit' | translate }}
                </a>
                <button mat-stroked-button type="button" class="send-link" [disabled]="busy() !== null" (click)="sendLink(person)">
                  {{ (isBusy(person, 'link') ? 'review.stale.sendingLink' : 'review.stale.sendLink') | translate }}
                </button>
              </div>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: REVIEW_LIST_STYLES,
})
export class StalePage {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly locale = inject(LocaleService);

  protected readonly state = signal<LoadState>('loading');
  protected readonly people = signal<ReviewPerson[]>([]);
  protected readonly busy = signal<{ id: string; action: Action } | null>(null);
  protected readonly confirmedName = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.api.get<ReviewPerson[]>('/review/stale').subscribe({
      next: (people) => {
        this.people.set(people);
        this.state.set('ready');
      },
      error: (failure: unknown) => {
        if (isMfaRequired(toApiError(failure))) void this.router.navigateByUrl('/mfa');
        this.state.set('failed');
      },
    });
  }

  protected detail(person: ReviewPerson): string {
    return [person.profession, person.city].filter(Boolean).join(' · ');
  }

  protected confirmedAgo(person: ReviewPerson): string {
    return relativeTime(person.last_confirmed_at, this.locale.locale());
  }

  protected isBusy(person: ReviewPerson, action: Action): boolean {
    const current = this.busy();
    return current?.id === person.person_id && current.action === action;
  }

  protected confirm(person: ReviewPerson): void {
    this.begin(person, 'confirm');
    this.api.post(`/people/${encodeURIComponent(person.person_id)}/confirm`).subscribe({
      next: () => {
        this.busy.set(null);
        this.people.update((people) => people.filter((p) => p.person_id !== person.person_id));
        this.confirmedName.set(person.display_name);
      },
      error: (failure: unknown) => this.fail(failure),
    });
  }

  protected sendLink(person: ReviewPerson): void {
    this.begin(person, 'link');
    const body: CreateLinkRequest = { person_id: person.person_id };
    this.api.post<IssuedLink>('/links', body).subscribe({
      next: (issued) => {
        this.busy.set(null);
        const data: LinkIssuedDialogData = {
          name: person.display_name,
          url: issued.url,
          expiresAt: issued.expires_at,
        };
        // The URL lives in the dialog only; this page keeps nothing of it.
        this.dialog.open(LinkIssuedDialog, { data });
      },
      error: (failure: unknown) => this.fail(failure),
    });
  }

  private begin(person: ReviewPerson, action: Action): void {
    this.busy.set({ id: person.person_id, action });
    this.confirmedName.set(null);
    this.error.set(null);
  }

  private fail(failure: unknown): void {
    const error = toApiError(failure);
    this.busy.set(null);
    if (isMfaRequired(error)) void this.router.navigateByUrl('/mfa');
    else this.error.set(actionErrorKey(error));
  }
}
