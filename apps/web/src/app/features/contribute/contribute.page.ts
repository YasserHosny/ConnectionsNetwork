import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContributeResponse } from '@connections/domain-types';
import { type Observable, tap } from 'rxjs';

import { toApiError } from '../../core/api.client';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import { LanguageSwitchComponent } from '../../layout/language-switch.component';
import { PersonFormComponent } from '../people/person-form.component';
import type { PersonFormValue, TagSuggest } from '../people/person-form.model';
import { ContributeApi, isLinkInvalid, isRateLimited, takeTokenFromLocation } from './contribute-api';

/** Where a contributor's unsent entry is kept: one slot, dropped as soon as the link is dead. */
const DRAFT_KEY = 'contribute';

/** What was submitted from this page, as the session list shows it. Memory only. */
interface AddedPerson {
  name: string;
  profession: string;
}

type Phase = 'loading' | 'ready' | 'expired' | 'failed';

/**
 * The public contributor page (spec 8.2): a contact opens `/c#<token>` from a WhatsApp link, with
 * no account, and adds people they know one after another. Each is connected to them.
 *
 * It stands outside the admin shell and never touches the sign-in session. The token is read from
 * the URL fragment, kept in memory and removed from the address bar before the first request.
 * What the contributor added in this visit is listed from memory: nothing is read back from the
 * server, and a reload starts empty.
 */
@Component({
  selector: 'app-contribute',
  imports: [MatButtonModule, TranslatePipe, LanguageSwitchComponent, PersonFormComponent],
  providers: [ContributeApi],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <header class="top">
        <app-language-switch />
      </header>

      @switch (phase()) {
        @case ('loading') {
          <p class="status" role="status">{{ 'common.loading' | translate }}</p>
        }
        @case ('expired') {
          <p class="expired" role="alert">{{ 'contribute.expired' | translate }}</p>
        }
        @case ('failed') {
          <div class="failed" role="alert">
            <p>{{ failureKey() | translate }}</p>
            <button mat-stroked-button type="button" class="retry-load" (click)="load()">
              {{ 'common.retry' | translate }}
            </button>
          </div>
        }
        @case ('ready') {
          <h1>{{ 'contribute.greeting' | translate: { name: contributorName() } }}</h1>
          <p class="intro">{{ 'contribute.intro' | translate }}</p>

          @if (justAdded(); as name) {
            <section class="added">
              <p class="thanks" role="status">{{ 'contribute.added' | translate: { name } }}</p>
              <button mat-flat-button type="button" class="add-another" (click)="justAdded.set(null)">
                {{ 'contribute.addAnother' | translate }}
              </button>
            </section>
          } @else {
            <h2>{{ 'contribute.title' | translate }}</h2>
            <app-person-form
              [contributor]="true"
              [draftKey]="draftKey"
              [suggestSource]="suggest"
              [submitter]="submit"
              (saved)="onSaved()"
            />
          }

          @if (added().length) {
            <section class="session">
              <h2>{{ 'contribute.listTitle' | translate }}</h2>
              <p class="note">{{ 'contribute.listNote' | translate }}</p>
              <ul class="session-list">
                @for (person of added(); track $index) {
                  <li>
                    <span class="name" dir="auto">{{ person.name }}</span>
                    @if (person.profession) {
                      <span class="profession" dir="auto">{{ person.profession }}</span>
                    }
                  </li>
                }
              </ul>
            </section>
          }
        }
      }
    </main>
  `,
  styles: `
    .page {
      box-sizing: border-box;
      max-inline-size: 640px;
      margin-inline: auto;
      padding-block: 8px 32px;
      padding-inline: 16px;
    }
    .top {
      display: flex;
      justify-content: flex-end;
    }
    h1 {
      margin-block: 8px 4px;
    }
    h2 {
      margin-block: 24px 12px;
      font: var(--mat-sys-title-medium);
    }
    .intro,
    .note {
      margin-block: 0 16px;
      color: var(--mat-sys-on-surface-variant);
    }
    .expired,
    .failed p {
      padding-block: 16px;
      padding-inline: 16px;
      border-radius: 12px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .added {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .thanks {
      margin: 0;
      padding-block: 12px;
      padding-inline: 16px;
      border-radius: 12px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .add-another {
      min-block-size: 48px;
    }
    .session-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .session-list li {
      display: flex;
      flex-wrap: wrap;
      column-gap: 12px;
      padding-block: 10px;
      padding-inline: 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
    }
    .name {
      font-weight: 600;
    }
    .profession {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class ContributePage implements OnInit {
  private readonly api = inject(ContributeApi);
  private readonly drafts = inject(DraftStore);
  private readonly locale = inject(LocaleService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly draftKey = DRAFT_KEY;
  protected readonly phase = signal<Phase>('loading');
  protected readonly failureKey = signal('person.errors.unreachable');
  protected readonly contributorName = signal('');
  /** The name just added, while the "thank you" is on screen instead of the form. */
  protected readonly justAdded = signal<string | null>(null);
  protected readonly added = signal<AddedPerson[]>([]);

  ngOnInit(): void {
    // Before any request: the token leaves the address bar first.
    const token = takeTokenFromLocation();
    this.api.setToken(token);
    if (!token) {
      // No token to try: say what the server would. A draft stays, for the next time the link is opened.
      this.phase.set('expired');
      return;
    }
    this.load();
  }

  protected load(): void {
    this.phase.set('loading');
    this.api
      .info()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          this.contributorName.set(info.contributor_display_name);
          this.phase.set('ready');
        },
        error: (failure: unknown) => this.onLoadFailure(failure),
      });
  }

  protected readonly suggest: TagSuggest = (kind, q) => this.api.tags(kind, q);

  protected readonly submit = (value: PersonFormValue): Observable<ContributeResponse> =>
    this.api.addPerson(value).pipe(
      tap({
        next: () => this.record(value),
        error: (failure: unknown) => {
          if (isLinkInvalid(toApiError(failure))) this.linkEnded();
        },
      }),
    );

  protected onSaved(): void {
    // `record` already ran for this person; this only swaps the form for the thank-you.
    const latest = this.added().at(-1);
    this.justAdded.set(latest?.name ?? '');
  }

  private record(value: PersonFormValue): void {
    const arabic = this.locale.locale() === 'ar';
    const [first, second] = arabic ? [value.nameAr, value.nameLatin] : [value.nameLatin, value.nameAr];
    this.added.update((list) => [
      ...list,
      { name: first.trim() || second.trim(), profession: value.profession.trim() },
    ]);
  }

  private onLoadFailure(failure: unknown): void {
    const error = toApiError(failure);
    if (isLinkInvalid(error)) {
      this.linkEnded();
    } else {
      this.failureKey.set(isRateLimited(error) ? 'person.errors.tooManyRequests' : 'person.errors.unreachable');
      this.phase.set('failed');
    }
  }

  /** The link no longer works: what was typed under it must not outlive it. */
  private linkEnded(): void {
    this.drafts.clear(DRAFT_KEY);
    this.phase.set('expired');
  }
}
