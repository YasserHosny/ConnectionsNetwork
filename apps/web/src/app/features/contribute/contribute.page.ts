import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, PendingTasks, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContributeResponse } from '@connections/domain-types';
import { type Observable, tap } from 'rxjs';

import { toApiError } from '../../core/api.client';
import { IsolatePipe } from '../../core/bidi';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import { LanguageSwitchComponent } from '../../layout/language-switch.component';
import { PersonFormComponent } from '../people/person-form.component';
import type { PersonFormValue, TagSuggest } from '../people/person-form.model';
import { ContributeApi, forgetToken, isLinkInvalid, isRateLimited, takeToken, tokenDigest } from './contribute-api';

/**
 * Where a contributor's unsent entry is kept: one slot, dropped as soon as the link is dead,
 * when another contributor's link opens on this device, or after a week.
 */
const DRAFT_KEY = 'contribute';
const DRAFT_MAX_AGE_DAYS = 7;

/** What was submitted from this page, as the session list shows it. Memory only. */
interface AddedPerson {
  name: string;
  profession: string;
}

type Phase = 'loading' | 'ready' | 'expired' | 'noToken' | 'failed';

/**
 * The public contributor page (spec 8.2): a contact opens `/c#<token>` from a WhatsApp link, with
 * no account, and adds people they know one after another. Each is connected to them.
 *
 * It stands outside the admin shell and never touches the sign-in session. The token is read from
 * the URL fragment and removed from the address bar and from the router's state before the first
 * request; it is kept for this tab (sessionStorage) so a reload still works, and forgotten as soon
 * as the server says the link is dead.
 * What the contributor added in this visit is listed from memory: nothing is read back from the
 * server, and a reload starts empty.
 */
@Component({
  selector: 'app-contribute',
  imports: [MatButtonModule, TranslatePipe, IsolatePipe, LanguageSwitchComponent, PersonFormComponent],
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
        @case ('noToken') {
          <p class="expired" role="alert">{{ 'contribute.noToken' | translate }}</p>
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
          <h1>{{ 'contribute.greeting' | translate: { name: (contributorName() | isolate) } }}</h1>
          <p class="intro">{{ 'contribute.intro' | translate }}</p>

          @if (justAdded(); as name) {
            <section class="added">
              <p class="thanks" role="status">{{ 'contribute.added' | translate: { name: (name | isolate) } }}</p>
              <button mat-flat-button type="button" class="add-another" (click)="justAdded.set(null)">
                {{ 'contribute.addAnother' | translate }}
              </button>
            </section>
          } @else {
            <h2>{{ 'contribute.title' | translate }}</h2>
            <app-person-form
              [contributor]="true"
              [draftKey]="draftKey"
              [draftOwner]="draftOwner()"
              [draftMaxAgeDays]="draftMaxAgeDays"
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
  private readonly router = inject(Router);
  private readonly pending = inject(PendingTasks);

  protected readonly draftKey = DRAFT_KEY;
  protected readonly draftMaxAgeDays = DRAFT_MAX_AGE_DAYS;
  protected readonly phase = signal<Phase>('loading');
  protected readonly failureKey = signal('person.errors.unreachable');
  protected readonly contributorName = signal('');
  /**
   * Whose draft this is: a digest of the link's token. Never the display name (two contributors can
   * share one) and never the token itself.
   */
  protected readonly draftOwner = signal<string | null>(null);
  private token: string | null = null;
  /** The name just added, while the "thank you" is on screen instead of the form. */
  protected readonly justAdded = signal<string | null>(null);
  protected readonly added = signal<AddedPerson[]>([]);

  ngOnInit(): void {
    // Before any request: the token leaves the address bar first.
    const lookup = takeToken();
    this.api.setToken(lookup.token);
    this.token = lookup.token;
    this.dropFragmentFromRouter();
    if (lookup.token === null) {
      // Nothing to try. No link at all: ask for the link from the message. Text that cannot be a
      // token: say what the server would. A draft stays, for the next time the link is opened.
      this.phase.set(lookup.reason === 'missing' ? 'noToken' : 'expired');
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
          // The form reads its draft when it opens, so the owner is known before it is shown.
          void this.ownerOf(this.token).then((owner) => {
            this.draftOwner.set(owner);
            this.contributorName.set(info.contributor_display_name);
            this.phase.set('ready');
          });
        },
        error: (failure: unknown) => this.onLoadFailure(failure),
      });
  }

  protected readonly suggest: TagSuggest = (kind, q) => this.api.tags(kind, q);

  protected readonly submit = (value: PersonFormValue, idempotencyKey: string): Observable<ContributeResponse> =>
    this.api.addPerson(value, idempotencyKey).pipe(
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

  /**
   * The router parsed `/c#<token>` itself, so its state (`Router.url`, the route's fragment, and
   * any navigation error it logs) still holds the token after the address bar is cleaned. Replace
   * that URL with the same one minus the fragment. The route is reused, so the page stays as it is.
   */
  private dropFragmentFromRouter(): void {
    const url = this.router.parseUrl(this.router.url);
    if (url.fragment === null) return;
    url.fragment = null;
    void this.router.navigateByUrl(url, { replaceUrl: true });
  }

  /**
   * The draft owner for this token. Without `crypto.subtle` no digest can be made: the owner is then
   * a random label that matches nothing, so no earlier draft is ever shown and none is restored later.
   */
  private ownerOf(token: string | null): Promise<string> {
    // The browser computes the digest outside Angular's sight: tell it the page is still busy.
    const done = this.pending.add();
    const digest = token === null ? Promise.reject(new Error('no token')) : tokenDigest(token);
    return digest
      .catch(() => `unverifiable-${Math.random().toString(36).slice(2)}`)
      .finally(done);
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

  /** The link no longer works: what was typed under it, and its token, must not outlive it. */
  private linkEnded(): void {
    forgetToken();
    this.drafts.clear(DRAFT_KEY);
    this.phase.set('expired');
  }
}
