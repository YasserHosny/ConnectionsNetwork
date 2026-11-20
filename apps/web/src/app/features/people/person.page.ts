import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  AlternativePath,
  AvailableFor,
  ConnectionOut,
  PersonOut,
  Seniority,
  SkillOut,
  SocialLinkOut,
} from '@connections/domain-types';
import { distinctUntilChanged, map } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { relativeTime } from '../../core/relative-time';
import { PathLineComponent } from '../search/path-line.component';
import { ContactListComponent } from './contact-list.component';
import { DeletePersonDialog } from './delete-person.dialog';
import { actionErrorKey } from './person-errors';
import {
  AVAILABLE_FOR_OPTIONS,
  SENIORITY_OPTIONS,
  SKILL_LEVEL_OPTIONS,
  SOCIAL_KIND_OPTIONS,
  STRENGTH_OPTIONS,
  labelKeyOf,
} from './person-form.model';

type LoadState = 'loading' | 'ready' | 'notFound' | 'failed';
type PathsState = 'loading' | 'ready' | 'failed';

/** The best path plus up to three alternatives: one request answers both. */
const PATH_COUNT = 4;

/**
 * A person (`/people/:id`, spec 8.7): the profile, their one-hop connections (each leads to that
 * person), the path from the admin, and edit, confirm and delete. The component is reused when
 * the admin follows a connection, so it reloads whenever the id in the route changes.
 */
@Component({
  selector: 'app-person-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe, PathLineComponent, ContactListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status">{{ 'common.loading' | translate }}</p>
      }
      @case ('notFound') {
        <p class="error" role="alert">{{ 'person.errors.notFound' | translate }}</p>
      }
      @case ('failed') {
        <p class="error" role="alert">{{ 'person.view.loadFailed' | translate }}</p>
        <button mat-stroked-button type="button" class="retry" (click)="load()">
          {{ 'common.retry' | translate }}
        </button>
      }
      @case ('ready') {
        @if (person(); as p) {
          <header class="header">
            <h1>{{ p.display_name }}</h1>
            @if (p.name_ar && p.name_latin) {
              <p class="other-name" dir="auto">{{ p.name_latin }}</p>
            }
            @if (p.is_stale) {
              <span class="stale-badge">{{ 'person.stale' | translate }}</span>
            }
          </header>

          <p class="summary">{{ summary() }}</p>
          <p class="confirmed-ago">{{ 'person.lastConfirmed' | translate: { when: confirmedAgo() } }}</p>

          <div class="actions">
            <a mat-stroked-button class="edit" [routerLink]="['/people', p.id, 'edit']">
              {{ 'person.view.edit' | translate }}
            </a>
            <button mat-stroked-button type="button" class="confirm" [disabled]="busy()" (click)="confirm()">
              {{ (busy() === 'confirm' ? 'person.view.confirming' : 'person.view.confirm') | translate }}
            </button>
            <button mat-stroked-button type="button" class="delete" [disabled]="busy()" (click)="remove()">
              {{ (busy() === 'delete' ? 'person.view.deleting' : 'person.view.delete') | translate }}
            </button>
          </div>
          @if (confirmed()) {
            <p class="confirmed" role="status">{{ 'person.view.confirmed' | translate }}</p>
          }
          @if (actionError(); as key) {
            <p class="action-error error" role="alert">{{ key | translate }}</p>
          }

          <div class="columns">
            <section class="profile">
              @if (p.seniority; as seniority) {
                <h2>{{ 'person.form.seniority' | translate }}</h2>
                <p class="seniority">{{ seniorityKey(seniority) | translate }}</p>
              }

              @if (p.available_for.length) {
                <h2>{{ 'person.form.availableFor' | translate }}</h2>
                <ul class="chips">
                  @for (item of p.available_for; track item) {
                    <li class="chip">{{ availableKey(item) | translate }}</li>
                  }
                </ul>
              }

              @if (p.skills.length) {
                <h2>{{ 'person.form.skills' | translate }}</h2>
                <ul class="chips">
                  @for (skill of p.skills; track skill.tag_id) {
                    <li class="chip">
                      {{ skill.label }}
                      @if (levelKey(skill); as key) {
                        <span>({{ key | translate }})</span>
                      }
                    </li>
                  }
                </ul>
              }

              @if (p.industries.length) {
                <h2>{{ 'person.form.industries' | translate }}</h2>
                <ul class="chips">
                  @for (industry of p.industries; track industry.tag_id) {
                    <li class="chip">{{ industry.label }}</li>
                  }
                </ul>
              }

              <h2>{{ 'person.form.contacts' | translate }}</h2>
              <app-contact-list class="contacts" [contacts]="p.contacts" />

              @if (p.social_links.length) {
                <h2>{{ 'person.form.socialLinks' | translate }}</h2>
                <ul class="links">
                  @for (link of p.social_links; track link.id) {
                    <li>
                      <span class="kind">{{ socialKey(link) | translate }}</span>
                      <a dir="ltr" [href]="link.url" target="_blank" rel="noopener noreferrer">{{ link.url }}</a>
                    </li>
                  }
                </ul>
              }

              @if (p.admin_notes) {
                <h2>{{ 'person.form.adminNotes' | translate }}</h2>
                <p class="notes" dir="auto">{{ p.admin_notes }}</p>
              }
            </section>

            <section class="network">
              <h2>{{ 'person.view.pathTitle' | translate }}</h2>
              @if (isSelf()) {
                <p class="is-you">{{ 'person.view.isYou' | translate }}</p>
              } @else {
                @switch (pathsState()) {
                  @case ('loading') {
                    <p>{{ 'common.loading' | translate }}</p>
                  }
                  @case ('failed') {
                    <p class="paths-error error" role="alert">{{ 'person.view.pathsFailed' | translate }}</p>
                  }
                  @case ('ready') {
                    @if (bestPath(); as best) {
                      <div class="best-path">
                        <app-path-line [path]="best.path" />
                        <span class="steps">{{ 'search.path.steps' | translate: { count: best.path.length - 1 } }}</span>
                      </div>
                      @if (alternatives().length) {
                        <button
                          mat-button
                          type="button"
                          class="toggle-alternatives"
                          [attr.aria-expanded]="showAlternatives()"
                          (click)="showAlternatives.set(!showAlternatives())"
                        >
                          {{ (showAlternatives() ? 'person.view.hideAlternatives' : 'person.view.alternatives') | translate }}
                        </button>
                        @if (showAlternatives()) {
                          <ul class="alternatives">
                            @for (alt of alternatives(); track $index) {
                              <li><app-path-line [path]="alt.path" /></li>
                            }
                          </ul>
                        }
                      }
                    } @else {
                      <p class="no-path">{{ 'person.view.noPath' | translate }}</p>
                    }
                  }
                }
              }

              <h2>{{ 'person.view.connections' | translate }}</h2>
              @if (p.connections.length) {
                <ul class="connections">
                  @for (connection of p.connections; track connection.id) {
                    <li>
                      <a [routerLink]="['/people', connection.person_id]">{{ connection.display_name }}</a>
                      <span class="chip">{{ strengthKey(connection) | translate }}</span>
                      @if (connection.note) {
                        <span class="note" dir="auto">{{ connection.note }}</span>
                      }
                    </li>
                  }
                </ul>
              } @else {
                <p class="none">{{ 'person.view.noConnections' | translate }}</p>
              }
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 1100px;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 12px;
    }
    h1 {
      margin: 0;
    }
    h2 {
      margin-block: 16px 6px;
      font: var(--mat-sys-title-small);
    }
    p {
      margin: 0;
    }
    .other-name,
    .summary,
    .confirmed-ago,
    .kind,
    .note,
    .none,
    .steps {
      color: var(--mat-sys-on-surface-variant);
    }
    .stale-badge {
      padding-block: 2px;
      padding-inline: 8px;
      border-radius: 8px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
      font: var(--mat-sys-label-small);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-block: 16px 8px;
    }
    .error {
      color: var(--mat-sys-error);
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 8px 32px;
    }
    .chips,
    .links,
    .connections,
    .alternatives {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      padding-block: 2px;
      padding-inline: 10px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-large);
    }
    .links li,
    .connections li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 10px;
      padding-block: 4px;
    }
    .alternatives {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .best-path {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 16px;
    }
    .no-path,
    .is-you {
      font-weight: 600;
    }
    .notes {
      white-space: pre-wrap;
    }
  `,
})
export class PersonPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly auth = inject(AuthService);
  private readonly locale = inject(LocaleService);

  protected readonly id = signal('');
  protected readonly state = signal<LoadState>('loading');
  protected readonly person = signal<PersonOut | null>(null);
  protected readonly pathsState = signal<PathsState>('loading');
  protected readonly paths = signal<AlternativePath[]>([]);
  protected readonly showAlternatives = signal(false);
  protected readonly busy = signal<'confirm' | 'delete' | null>(null);
  protected readonly confirmed = signal(false);
  protected readonly actionError = signal<string | null>(null);

  protected readonly isSelf = computed(() => this.id() === this.auth.personId());
  protected readonly bestPath = computed(() => this.paths()[0] ?? null);
  protected readonly alternatives = computed(() => this.paths().slice(1));
  protected readonly confirmedAgo = computed(() => {
    const person = this.person();
    return person ? relativeTime(person.last_confirmed_at, this.locale.locale()) : '';
  });
  protected readonly summary = computed(() => {
    const person = this.person();
    if (!person) return '';
    return [
      person.headline,
      person.organization,
      person.profession,
      person.city,
      person.country,
    ]
      .filter(Boolean)
      .join(' · ');
  });

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe((id) => {
        this.id.set(id);
        this.load();
      });
  }

  protected load(): void {
    const id = this.id();
    // A response for a person the admin has already left is ignored.
    const current = () => this.id() === id;

    this.state.set('loading');
    this.person.set(null);
    this.paths.set([]);
    this.showAlternatives.set(false);
    this.confirmed.set(false);
    this.actionError.set(null);

    this.api.get<PersonOut>(this.path(id)).subscribe({
      next: (person) => {
        if (!current()) return;
        this.person.set(person);
        this.state.set('ready');
      },
      error: (failure: unknown) => {
        if (!current()) return;
        this.state.set(toApiError(failure).code === 'not_found' ? 'notFound' : 'failed');
      },
    });

    if (this.isSelf()) {
      // The path from you to you is just you; there is nothing to ask for.
      this.pathsState.set('ready');
      return;
    }
    this.pathsState.set('loading');
    this.api.get<AlternativePath[]>(`${this.path(id)}/paths`, { k: PATH_COUNT }).subscribe({
      next: (paths) => {
        if (!current()) return;
        this.paths.set(paths);
        this.pathsState.set('ready');
      },
      error: () => {
        if (current()) this.pathsState.set('failed');
      },
    });
  }

  protected confirm(): void {
    const id = this.id();
    this.begin('confirm');
    this.api.post<PersonOut>(`${this.path(id)}/confirm`).subscribe({
      next: (person) => {
        this.busy.set(null);
        if (this.id() !== id) return;
        this.person.set(person);
        this.confirmed.set(true);
      },
      error: (failure: unknown) => this.fail(failure),
    });
  }

  protected remove(): void {
    const person = this.person();
    if (!person) return;
    this.dialog
      .open(DeletePersonDialog, { data: { name: person.display_name } })
      .afterClosed()
      .subscribe((confirmed: boolean | undefined) => {
        if (confirmed === true) this.deletePerson(person.id);
      });
  }

  protected availableKey(item: AvailableFor): string {
    return labelKeyOf(AVAILABLE_FOR_OPTIONS, item);
  }

  protected seniorityKey(seniority: Seniority): string {
    return labelKeyOf(SENIORITY_OPTIONS, seniority);
  }

  protected levelKey(skill: SkillOut): string | null {
    return skill.level ? labelKeyOf(SKILL_LEVEL_OPTIONS, skill.level) : null;
  }

  protected socialKey(link: SocialLinkOut): string {
    return labelKeyOf(SOCIAL_KIND_OPTIONS, link.kind);
  }

  protected strengthKey(connection: ConnectionOut): string {
    return labelKeyOf(STRENGTH_OPTIONS, connection.strength);
  }

  private deletePerson(id: string): void {
    this.begin('delete');
    this.api.delete(this.path(id)).subscribe({
      next: () => {
        this.busy.set(null);
        void this.router.navigateByUrl('/search');
      },
      error: (failure: unknown) => this.fail(failure),
    });
  }

  private begin(action: 'confirm' | 'delete'): void {
    this.busy.set(action);
    this.confirmed.set(false);
    this.actionError.set(null);
  }

  private fail(failure: unknown): void {
    this.busy.set(null);
    this.actionError.set(actionErrorKey(toApiError(failure)));
  }

  private path(id: string): string {
    return `/people/${encodeURIComponent(id)}`;
  }
}
