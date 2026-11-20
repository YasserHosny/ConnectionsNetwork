import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type {
  DismissRequest,
  DuplicatePair,
  MergeRequest,
  PersonSummary,
} from '@connections/domain-types';
import type { Observable } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { ConfirmDialog, type ConfirmDialogData } from '../../layout/confirm.dialog';
import { actionErrorKey, isMfaRequired, isPersonGone } from '../people/person-errors';
import { REVIEW_LIST_STYLES } from './review-list.styles';

type LoadState = 'loading' | 'ready' | 'failed';

interface Message {
  key: string;
  params: Record<string, string>;
}

/** The i18n key for each reason a pair was flagged (`matched_on`). */
const MATCH_KEYS: Record<DuplicatePair['matched_on'][number], string> = {
  phone: 'review.duplicates.matchedOn.phone',
  email: 'review.duplicates.matchedOn.email',
  social_link: 'review.duplicates.matchedOn.socialLink',
};

/**
 * Possible duplicates (spec 8.4): each pair side by side. "Keep this one" on a side merges the
 * other record into it, after a confirmation that names the record kept: a merge cannot be
 * undone. "Not the same person" dismisses the pair for good.
 */
@Component({
  selector: 'app-duplicates-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="intro">{{ 'review.duplicates.intro' | translate }}</p>

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
        @if (message(); as m) {
          <p class="status" role="status">{{ m.key | translate: m.params }}</p>
        }
        @if (error(); as key) {
          <p class="error" role="alert">{{ key | translate }}</p>
        }

        @if (pairs().length === 0) {
          <p class="empty">{{ 'review.duplicates.empty' | translate }}</p>
        }

        <ul class="people">
          @for (pair of pairs(); track pairKey(pair); let i = $index) {
            <li class="pair person">
              <div class="sides">
                @for (side of [{ keep: pair.a, drop: pair.b }, { keep: pair.b, drop: pair.a }]; track side.keep.person_id; let first = $first) {
                  <section class="side">
                    <p class="record">{{ 'review.duplicates.record' | translate: { n: first ? 1 : 2 } }}</p>
                    <h2 class="side-name" [id]="'dup-' + i + (first ? '-a' : '-b')">
                      <a class="name" [routerLink]="['/people', side.keep.person_id]">{{ side.keep.display_name }}</a>
                    </h2>
                    @if (detail(side.keep); as text) {
                      <p class="detail">{{ text }}</p>
                    }
                    <button
                      mat-flat-button
                      type="button"
                      class="keep"
                      [disabled]="busy()"
                      [attr.aria-describedby]="'dup-' + i + (first ? '-a' : '-b')"
                      (click)="merge(side.keep, side.drop, first)"
                    >
                      {{ (busy() ? 'review.duplicates.working' : 'review.duplicates.keep') | translate }}
                    </button>
                  </section>
                }
              </div>
              <ul class="reasons">
                @for (reason of pair.matched_on; track reason) {
                  <li class="chip">{{ matchKey(reason) | translate }}</li>
                }
              </ul>
              <div class="actions">
                <button mat-stroked-button type="button" class="dismiss" [disabled]="busy()" (click)="dismiss(pair)">
                  {{ 'review.duplicates.dismiss' | translate }}
                </button>
              </div>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: `
    ${REVIEW_LIST_STYLES}
    .pair {
      grid-template-columns: minmax(0, 1fr);
    }
    .sides {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .side {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      padding: 12px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
    }
    .record {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
    }
    .side-name {
      margin: 0;
    }
    .reasons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .chip {
      padding-block: 2px;
      padding-inline: 10px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-large);
    }
  `,
})
export class DuplicatesPage {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly state = signal<LoadState>('loading');
  protected readonly pairs = signal<DuplicatePair[]>([]);
  protected readonly busy = signal(false);
  protected readonly message = signal<Message | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.fetch();
  }

  protected pairKey(pair: DuplicatePair): string {
    return `${pair.a.person_id}:${pair.b.person_id}`;
  }

  protected detail(person: PersonSummary): string {
    return [person.profession, person.city].filter(Boolean).join(' · ');
  }

  protected matchKey(reason: DuplicatePair['matched_on'][number]): string {
    return MATCH_KEYS[reason];
  }

  /**
   * Duplicates are often the same name twice, so the dialog names each record by its number on
   * the page and its detail ("Sara Mahmoud (Record 2 · Marketing · Cairo)"). The number is
   * position, not left or right, so it reads the same in Arabic.
   */
  private label(person: PersonSummary, number: 1 | 2): string {
    const record = this.translate.instant('review.duplicates.record', { n: number }) as string;
    return `${person.display_name} (${[record, this.detail(person)].filter(Boolean).join(' · ')})`;
  }

  protected merge(keep: PersonSummary, drop: PersonSummary, keepIsFirst: boolean): void {
    const data: ConfirmDialogData = {
      titleKey: 'review.duplicates.mergeDialog.title',
      bodyKey: 'review.duplicates.mergeDialog.body',
      confirmKey: 'review.duplicates.mergeDialog.confirm',
      params: {
        keep: this.label(keep, keepIsFirst ? 1 : 2),
        drop: this.label(drop, keepIsFirst ? 2 : 1),
      },
    };
    this.dialog
      .open(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((confirmed: boolean | undefined) => {
        if (confirmed !== true) return;
        const body: MergeRequest = { keep: keep.person_id, drop: drop.person_id };
        this.run(this.api.post('/duplicates/merge', body), () => {
          this.message.set({
            key: 'review.duplicates.merged',
            params: { keep: keep.display_name, drop: drop.display_name },
          });
          // The dropped person may sit in other pairs too: ask the API again.
          this.fetch();
        });
      });
  }

  protected dismiss(pair: DuplicatePair): void {
    const body: DismissRequest = { a: pair.a.person_id, b: pair.b.person_id };
    this.run(this.api.post<void>('/duplicates/dismiss', body), () => {
      this.pairs.update((pairs) => pairs.filter((p) => this.pairKey(p) !== this.pairKey(pair)));
      this.message.set({ key: 'review.duplicates.dismissed', params: {} });
    });
  }

  private run(request: Observable<unknown>, done: () => void): void {
    this.busy.set(true);
    this.message.set(null);
    this.error.set(null);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        done();
      },
      error: (failure: unknown) => {
        this.busy.set(false);
        const apiError = toApiError(failure);
        if (isMfaRequired(apiError)) {
          void this.router.navigateByUrl('/mfa');
        } else if (isPersonGone(apiError)) {
          this.error.set('review.gone');
          this.fetch();
        } else {
          this.error.set(actionErrorKey(apiError));
        }
      },
    });
  }

  /** Reads the list without hiding the page, so a message about what just happened stays. */
  private fetch(): void {
    this.api.get<DuplicatePair[]>('/duplicates').subscribe({
      next: (pairs) => {
        this.pairs.set(pairs);
        this.state.set('ready');
      },
      error: (failure: unknown) => {
        if (isMfaRequired(toApiError(failure))) void this.router.navigateByUrl('/mfa');
        this.state.set('failed');
      },
    });
  }
}
