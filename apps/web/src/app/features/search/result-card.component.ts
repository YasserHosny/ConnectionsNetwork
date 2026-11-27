import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ContactOut, PersonOut, SearchResult } from '@connections/domain-types';
import { firstValueFrom } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { IsolatePipe } from '../../core/bidi';
import { copyText } from '../../core/clipboard';
import { LocaleService } from '../../core/locale.service';
import { relativeTime } from '../../core/relative-time';
import { ContactListComponent } from '../people/contact-list.component';
import { actionErrorKey } from '../people/person-errors';
import {
  AVAILABLE_FOR_OPTIONS,
  SKILL_LEVEL_OPTIONS,
  labelKeyOf,
} from '../people/person-form.model';
import { buildIntroMessage, pickWhatsappNumber, whatsappUrl } from './intro-message';
import { PathLineComponent } from './path-line.component';

type IntroStatus = 'copied' | 'copyFailed' | 'blocked';

/** The message prepared for the first hop, shown when WhatsApp did not open by itself. */
interface IntroPanel {
  text: string;
  name: string;
  status: IntroStatus;
  whatsappUrl: string | null;
}

const INTRO_STATUS_KEYS: Record<IntroStatus, string> = {
  copied: 'search.intro.copied',
  copyFailed: 'search.intro.copyFailed',
  blocked: 'search.intro.whatsappBlocked',
};

/**
 * One search result (spec 8.6): who, what they are good at, how stale the data is, the path from
 * you, and two actions. Search results carry no contact values, so both actions fetch the person
 * they need when pressed: "Ask <first hop> for an intro" (WhatsApp, or copy the message) and
 * "Contact directly" (the target's contacts). Contact values are never logged.
 */
@Component({
  selector: 'app-result-card',
  imports: [MatButtonModule, RouterLink, TranslatePipe, IsolatePipe, PathLineComponent, ContactListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="card">
      <div class="info">
        <h2 class="title">
          <a class="name" dir="auto" [routerLink]="['/people', result().person_id]">{{ result().display_name }}</a>
          @if (result().is_stale) {
            <span class="stale-badge">{{ 'person.stale' | translate }}</span>
          }
        </h2>

        @if (subtitle(); as text) {
          <p class="subtitle">{{ text }}</p>
        }

        @if (result().matched_skills.length) {
          <ul class="chips skills">
            @for (skill of result().matched_skills; track skill.label) {
              <li class="skill">
                {{ skill.label }}
                @if (skill.level) {
                  <span class="level">({{ levelKey(skill.level) | translate }})</span>
                }
              </li>
            }
          </ul>
        }

        <p class="meta">
          @if (result().available_for.length) {
            <span class="available">
              {{ 'search.availableFor' | translate }}
              @for (item of result().available_for; track item) {
                <span class="chip">{{ availableKey(item) | translate }}</span>
              }
            </span>
          }
          <span class="confirmed">{{ 'person.lastConfirmed' | translate: { when: confirmedAgo() } }}</span>
        </p>

        @if (reachable()) {
          <div class="path">
            <app-path-line [path]="result().path" />
            <span class="steps">{{ 'search.path.steps' | translate: { count: result().steps } }}</span>
          </div>
        } @else {
          <p class="not-connected">{{ 'search.notConnected' | translate }}</p>
        }
      </div>

      <div class="actions">
        @if (canAskIntro()) {
          <button
            mat-flat-button
            type="button"
            class="ask-intro"
            [disabled]="busy()"
            (click)="askIntro()"
          >
            {{ 'search.askIntro' | translate: { name: (firstHop().display_name | isolate) } }}
          </button>
        }
        <button
          mat-stroked-button
          type="button"
          class="contact-direct"
          [disabled]="busy()"
          [attr.aria-expanded]="showContacts()"
          (click)="toggleContacts()"
        >
          {{ (showContacts() ? 'search.hideContacts' : 'search.contactDirectly') | translate }}
        </button>
      </div>

      @if (error(); as key) {
        <p class="error" role="alert">{{ key | translate }}</p>
      }

      @if (intro(); as panel) {
        <div class="intro-panel">
          <p class="intro-status" role="status">{{ statusKey(panel) | translate: { name: (panel.name | isolate) } }}</p>
          <textarea
            class="intro-text"
            readonly
            rows="3"
            dir="auto"
            [attr.aria-label]="'search.intro.textLabel' | translate: { name: (panel.name | isolate) }"
            [value]="panel.text"
          ></textarea>
          @if (panel.whatsappUrl; as url) {
            <a mat-flat-button class="open-whatsapp" [href]="url" target="_blank" rel="noopener noreferrer">
              {{ 'search.intro.openWhatsapp' | translate }}
            </a>
          }
        </div>
      }

      @if (showContacts() && contacts(); as list) {
        <div class="contacts">
          <app-contact-list [contacts]="list" />
        </div>
      }
    </article>
  `,
  styles: `
    :host {
      display: block;
    }
    .card {
      display: grid;
      gap: 12px 24px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
    }
    .info {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-inline-size: 0;
    }
    p {
      margin: 0;
    }
    .title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    .name {
      color: inherit;
    }
    .stale-badge {
      padding-block: 2px;
      padding-inline: 8px;
      border-radius: 8px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
      font: var(--mat-sys-label-small);
    }
    .subtitle,
    .meta,
    .steps {
      color: var(--mat-sys-on-surface-variant);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .skill,
    .chip {
      padding-block: 2px;
      padding-inline: 10px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-large);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
    }
    .available {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .path {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 16px;
    }
    .not-connected {
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
    }
    .error {
      color: var(--mat-sys-error);
    }
    .intro-panel,
    .contacts {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .intro-text {
      inline-size: 100%;
      box-sizing: border-box;
      padding: 8px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: inherit;
      font: inherit;
      resize: vertical;
    }

    /* Laptop: details on one side, actions on the other. Phone: everything stacks. */
    @media (min-width: 800px) {
      .card {
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
      }
      .actions {
        flex-direction: column;
        align-items: stretch;
        grid-column: 2;
        grid-row: 1;
      }
      .error,
      .intro-panel,
      .contacts {
        grid-column: 1 / -1;
      }
    }
  `,
})
export class ResultCardComponent {
  private readonly api = inject(ApiClient);
  private readonly locale = inject(LocaleService);
  private readonly window = inject(DOCUMENT).defaultView;

  readonly result = input.required<SearchResult>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly intro = signal<IntroPanel | null>(null);
  protected readonly showContacts = signal(false);
  /** The target's contacts once fetched; kept so hiding and showing them costs no request. */
  protected readonly contacts = signal<ContactOut[] | null>(null);

  /** A path with at least you and the target; an unreachable person has none. */
  protected readonly reachable = computed(() => this.result().path.length >= 2);
  /** Someone sits between you and the target; a direct contact has nobody to ask. */
  protected readonly canAskIntro = computed(() => this.result().path.length >= 3);
  protected readonly firstHop = computed(() => this.result().path[1]);
  protected readonly confirmedAgo = computed(() =>
    relativeTime(this.result().last_confirmed_at, this.locale.locale()),
  );
  protected readonly subtitle = computed(() => {
    const { profession, headline, city } = this.result();
    return [profession, headline, city].filter(Boolean).join(' · ');
  });

  protected levelKey(level: NonNullable<SearchResult['matched_skills'][number]['level']>): string {
    return labelKeyOf(SKILL_LEVEL_OPTIONS, level);
  }

  protected availableKey(item: SearchResult['available_for'][number]): string {
    return labelKeyOf(AVAILABLE_FOR_OPTIONS, item);
  }

  protected statusKey(panel: IntroPanel): string {
    return INTRO_STATUS_KEYS[panel.status];
  }

  protected async askIntro(): Promise<void> {
    const hop = this.firstHop();
    this.begin();
    const person = await this.fetchPerson(hop.person_id);
    if (!person) return;

    const text = buildIntroMessage(this.locale.locale(), this.result().path);
    const number = pickWhatsappNumber(person.contacts);
    // A number WhatsApp cannot be sure of (no country to place it in) gets the copy fallback.
    const url = number ? whatsappUrl(number, text) : null;
    if (url) {
      const opened = this.window?.open(url, '_blank');
      if (opened) {
        // Not "noopener": that makes open() return null, which reads as a blocked popup.
        opened.opener = null;
        return;
      }
      this.intro.set({ text, name: hop.display_name, status: 'blocked', whatsappUrl: url });
      return;
    }
    const copied = await copyText(text);
    this.intro.set({
      text,
      name: hop.display_name,
      status: copied ? 'copied' : 'copyFailed',
      whatsappUrl: null,
    });
  }

  protected async toggleContacts(): Promise<void> {
    if (this.showContacts()) {
      this.showContacts.set(false);
      return;
    }
    this.error.set(null);
    if (!this.contacts()) {
      this.begin();
      const person = await this.fetchPerson(this.result().person_id);
      if (!person) return;
      this.contacts.set(person.contacts);
    }
    this.showContacts.set(true);
  }

  private begin(): void {
    this.busy.set(true);
    this.error.set(null);
    this.intro.set(null);
  }

  /** The person, or null after the failure has been shown (ApiClient handles an ended session). */
  private async fetchPerson(id: string): Promise<PersonOut | null> {
    try {
      return await firstValueFrom(this.api.get<PersonOut>(`/people/${encodeURIComponent(id)}`));
    } catch (failure) {
      this.error.set(actionErrorKey(toApiError(failure)));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}
