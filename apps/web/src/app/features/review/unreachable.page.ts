import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ReviewPerson } from '@connections/domain-types';

import { ApiClient, toApiError } from '../../core/api.client';
import { isMfaRequired } from '../people/person-errors';
import { ConnectDialog, type ConnectDialogData } from './connect.dialog';
import { REVIEW_LIST_STYLES } from './review-list.styles';

type LoadState = 'loading' | 'ready' | 'failed';

/**
 * People with no path from the admin (spec 9), for example after a bridging person was deleted.
 * "Connect…" opens a dialog to pick who they are connected to and how strongly; once connected
 * they leave the list.
 */
@Component({
  selector: 'app-unreachable-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="intro">{{ 'review.unreachable.intro' | translate }}</p>

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
        @if (connectedName(); as name) {
          <p class="status" role="status">{{ 'review.unreachable.connected' | translate: { name } }}</p>
        }

        @if (people().length === 0) {
          <p class="empty">{{ 'review.unreachable.empty' | translate }}</p>
        }

        <ul class="people">
          @for (person of people(); track person.person_id) {
            <li class="person">
              <div class="info">
                <a class="name" [routerLink]="['/people', person.person_id]">{{ person.display_name }}</a>
                @if (detail(person); as text) {
                  <span class="detail">{{ text }}</span>
                }
              </div>
              <div class="actions">
                <button mat-flat-button type="button" class="connect" (click)="connect(person)">
                  {{ 'review.unreachable.connect' | translate }}
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
export class UnreachablePage {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);

  protected readonly state = signal<LoadState>('loading');
  protected readonly people = signal<ReviewPerson[]>([]);
  protected readonly connectedName = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.api.get<ReviewPerson[]>('/review/unreachable').subscribe({
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

  protected connect(person: ReviewPerson): void {
    const data: ConnectDialogData = { person: { id: person.person_id, name: person.display_name } };
    this.dialog
      .open(ConnectDialog, { data })
      .afterClosed()
      .subscribe((connected: boolean | undefined) => {
        if (connected !== true) return;
        this.people.update((people) => people.filter((p) => p.person_id !== person.person_id));
        this.connectedName.set(person.display_name);
      });
  }
}
