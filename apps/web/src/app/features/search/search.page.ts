import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { SearchResult } from '@connections/domain-types';
import { type Observable, Subject, catchError, concat, map, of, switchMap } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { actionErrorKey } from '../people/person-errors';
import {
  AVAILABLE_FOR_OPTIONS,
  SENIORITY_OPTIONS,
  SKILL_CATEGORY_OPTIONS,
  SKILL_LEVEL_OPTIONS,
} from '../people/person-form.model';
import { ResultCardComponent } from './result-card.component';
import {
  EMPTY_FILTERS,
  type SearchFilters,
  filtersFromParams,
  hasCriteria,
  hasContactValue,
  toApiParams,
  toUrlParams,
  RESULT_LIMIT,
} from './search-query';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; results: SearchResult[] }
  | { kind: 'error'; key: string };

/**
 * Search (spec 8.6): free text plus filters, ranked by closeness to the admin.
 *
 * The query and filters live in the URL query string, so back, forward and reload work. Contact
 * values are not searchable and must never reach a URL: a phone-like or email-like query is not
 * searched, not written to the URL, and is removed from it if it arrives there.
 */
@Component({
  selector: 'app-search-page',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    ResultCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.search.title' | translate }}</h1>

    <form class="search-form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="query-row">
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="query">
          <mat-label>{{ 'search.queryLabel' | translate }}</mat-label>
          <input
            #queryInput
            matInput
            type="search"
            name="q"
            formControlName="q"
            autocomplete="off"
            enterkeyhint="search"
          />
        </mat-form-field>
        <button mat-flat-button type="submit" class="submit" [disabled]="loading()">
          {{ (loading() ? 'search.searching' : 'search.submit') | translate }}
        </button>
        <button mat-button type="button" class="clear" (click)="clear()">
          {{ 'search.clear' | translate }}
        </button>
      </div>

      <!-- Folded on a phone unless one is set, so the results are not pushed below six fields. -->
      <details class="filters-panel" [open]="filtersOpen()" (toggle)="onFiltersToggle($event)">
        <summary>
          {{ 'search.filtersTitle' | translate }}
          @if (activeFilters()) {
            <span class="active-count">({{ activeFilters() }})</span>
          }
        </summary>
      <fieldset class="filters">
        <legend class="cdk-visually-hidden">{{ 'search.filtersTitle' | translate }}</legend>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.category' | translate }}</mat-label>
          <select matNativeControl name="category" formControlName="category">
            <option value="">{{ 'search.filters.any' | translate }}</option>
            @for (option of categories; track option.value) {
              <option [value]="option.value">{{ option.labelKey | translate }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.minLevel' | translate }}</mat-label>
          <select matNativeControl name="minLevel" formControlName="minLevel">
            <option value="">{{ 'search.filters.any' | translate }}</option>
            @for (option of levels; track option.value) {
              <option [value]="option.value">{{ option.labelKey | translate }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.industry' | translate }}</mat-label>
          <input matInput name="industry" formControlName="industry" autocomplete="off" />
        </mat-form-field>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.seniority' | translate }}</mat-label>
          <select matNativeControl name="seniority" formControlName="seniority">
            <option value="">{{ 'search.filters.any' | translate }}</option>
            @for (option of seniorities; track option.value) {
              <option [value]="option.value">{{ option.labelKey | translate }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.availableFor' | translate }}</mat-label>
          <select matNativeControl name="availableFor" formControlName="availableFor">
            <option value="">{{ 'search.filters.any' | translate }}</option>
            @for (option of availableFor; track option.value) {
              <option [value]="option.value">{{ option.labelKey | translate }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'search.filters.city' | translate }}</mat-label>
          <input matInput name="city" formControlName="city" autocomplete="off" />
        </mat-form-field>
      </fieldset>
      </details>
    </form>

    <section class="outcome" aria-live="polite">
      @if (contactHint()) {
        <p class="contact-hint" role="status">{{ 'search.contactHint' | translate }}</p>
      }

      @if (errorKey(); as key) {
        <p class="error" role="alert">{{ key | translate }}</p>
      } @else if (loading()) {
        <p class="loading">{{ 'common.loading' | translate }}</p>
      } @else if (searched()) {
        @if (results().length) {
          <p class="count">{{ 'search.resultsCount' | translate: { count: results().length } }}</p>
          @if (results().length >= resultLimit) {
            <p class="limit-note">{{ 'search.limitReached' | translate: { count: resultLimit } }}</p>
          }
          <ul class="results">
            @for (result of results(); track result.person_id) {
              <li><app-result-card [result]="result" /></li>
            }
          </ul>
        } @else {
          <p class="no-results">{{ 'search.noResults' | translate }}</p>
        }
      } @else if (!contactHint()) {
        <p class="idle" [attr.role]="nudged() ? 'status' : null">{{ 'search.idle' | translate }}</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 1100px;
    }
    .search-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .query-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .query {
      flex: 1 1 260px;
    }
    .filters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
    .filters-panel > summary {
      margin-block-end: 8px;
      font: var(--mat-sys-title-small);
      cursor: pointer;
    }
    .active-count {
      color: var(--mat-sys-primary);
    }
    legend {
      padding: 0;
      margin-block-end: 8px;
      font: var(--mat-sys-title-small);
    }
    .outcome {
      margin-block-start: 16px;
    }
    .results {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .count,
    .limit-note,
    .idle,
    .no-results,
    .loading,
    .contact-hint {
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class SearchPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly categories = SKILL_CATEGORY_OPTIONS;
  protected readonly levels = SKILL_LEVEL_OPTIONS;
  protected readonly seniorities = SENIORITY_OPTIONS;
  protected readonly availableFor = AVAILABLE_FOR_OPTIONS;

  protected readonly form = inject(FormBuilder).nonNullable.group({ ...EMPTY_FILTERS });

  protected readonly results = signal<SearchResult[]>([]);
  /** The API returns at most this many, closest first; a full page says so. */
  protected readonly resultLimit = RESULT_LIMIT;
  protected readonly loading = signal(false);
  /** True once a search has answered, so "no results" is not shown before anything was asked. */
  protected readonly searched = signal(false);
  protected readonly errorKey = signal<string | null>(null);
  protected readonly contactHint = signal(false);
  /** Search was pressed with nothing to search: the hint is announced and the text field focused. */
  protected readonly nudged = signal(false);
  protected readonly filtersOpen = signal(window.matchMedia('(min-width: 720px)').matches);
  protected readonly activeFilters = signal(0);
  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

  private readonly searches = new Subject<SearchFilters | null>();
  /** A contact-like query was just taken out of the URL: keep saying why across that redirect. */
  private hintCarriesOver = false;

  constructor() {
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      const filters: Partial<SearchFilters> = { ...this.form.getRawValue() };
      delete filters.q;
      this.activeFilters.set(Object.values(filters).filter((v) => v !== '').length);
    });
    this.searches
      .pipe(
        switchMap((filters) => this.run(filters)),
        takeUntilDestroyed(),
      )
      .subscribe((outcome) => this.show(outcome));

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const { filters, contactLike } = filtersFromParams(params);
      this.form.setValue(filters);
      if (this.activeFilters()) this.filtersOpen.set(true);
      this.contactHint.set(contactLike || this.hintCarriesOver);
      this.hintCarriesOver = contactLike;
      if (contactLike) {
        // Take it out of the address bar; the redirect carries on with the remaining filters.
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: toUrlParams(filters),
          replaceUrl: true,
        });
        return;
      }
      this.searches.next(filters);
    });
  }

  protected submit(): void {
    const filters = this.form.getRawValue() as SearchFilters;
    this.contactHint.set(false);
    if (!hasCriteria(filters)) {
      this.nudged.set(true);
      this.queryInput()?.nativeElement.focus();
      return;
    }
    this.nudged.set(false);
    this.go(filters);
  }

  protected onFiltersToggle(event: Event): void {
    this.filtersOpen.set((event.target as HTMLDetailsElement).open);
  }

  protected clear(): void {
    this.nudged.set(false);
    this.form.setValue(EMPTY_FILTERS);
    this.go(EMPTY_FILTERS);
  }

  /** Puts the filters in the URL (which runs the search), or searches again when it is unchanged. */
  private go(filters: SearchFilters): void {
    if (hasContactValue(filters)) {
      this.contactHint.set(true);
      this.searches.next(null);
      return;
    }
    const next = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: toUrlParams(filters),
    });
    if (this.router.serializeUrl(next) === this.router.url) {
      // Nothing in the URL would change, so no navigation happens: search again directly.
      this.searches.next(filters);
    } else {
      void this.router.navigateByUrl(next);
    }
  }

  private run(filters: SearchFilters | null): Observable<Outcome> {
    if (!filters || !hasCriteria(filters)) return of<Outcome>({ kind: 'idle' });
    return concat(
      of<Outcome>({ kind: 'loading' }),
      this.api.get<SearchResult[]>('/search', toApiParams(filters)).pipe(
        map((results): Outcome => ({ kind: 'done', results })),
        catchError((failure: unknown) => {
          return of<Outcome>({ kind: 'error', key: actionErrorKey(toApiError(failure)) });
        }),
      ),
    );
  }

  private show(outcome: Outcome): void {
    this.loading.set(outcome.kind === 'loading');
    this.errorKey.set(outcome.kind === 'error' ? outcome.key : null);
    if (outcome.kind === 'done') {
      this.results.set(outcome.results);
      this.searched.set(true);
    } else if (outcome.kind !== 'loading') {
      this.results.set([]);
      this.searched.set(false);
    }
  }
}
