import { ChangeDetectionStrategy, Component, DestroyRef, inject, model, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { SearchResult } from '@connections/domain-types';
import { type Observable, Subject, catchError, debounceTime, map, of, switchMap } from 'rxjs';

import { ApiClient } from '../../core/api.client';
import type { ConnectTarget } from './person-form.model';

const SEARCH_DELAY_MS = 300;
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 8;

interface Outcome {
  results: SearchResult[];
  failed: boolean;
}

/**
 * "Connected to": who the new person is connected to (spec 8.3). `null` is the admin, the default.
 * Anyone else is found by name through `GET /search`, which excludes the admin: that is why the
 * admin is the default and a "use me" button, not a search result.
 */
@Component({
  selector: 'app-person-picker',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="picker">
      <legend>{{ 'person.connectTo.label' | translate }}</legend>

      <p class="selected">
        @if (value(); as target) {
          <span>{{ target.name }}</span>
          <button mat-button type="button" class="reset" (click)="reset()">
            {{ 'person.connectTo.reset' | translate }}
          </button>
        } @else {
          <span>{{ 'person.connectTo.me' | translate }}</span>
        }
      </p>

      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>{{ 'person.connectTo.search' | translate }}</mat-label>
        <input matInput type="search" autocomplete="off" [value]="query()" (input)="onInput($event)" />
      </mat-form-field>

      @if (failed()) {
        <p class="error" role="alert">{{ 'person.connectTo.searchFailed' | translate }}</p>
      } @else if (results().length) {
        <ul class="results">
          @for (result of results(); track result.person_id) {
            <li>
              <button type="button" (click)="pick(result)">
                <span>{{ result.display_name }}</span>
                @if (detail(result); as text) {
                  <small>{{ text }}</small>
                }
              </button>
            </li>
          }
        </ul>
      } @else if (noResults()) {
        <p class="hint">{{ 'person.connectTo.noResults' | translate }}</p>
      }
    </fieldset>
  `,
  styles: `
    .picker {
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
    mat-form-field {
      inline-size: 100%;
    }
    legend {
      padding: 0;
      font: var(--mat-sys-title-small);
    }
    .selected {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-block: 4px 8px;
    }
    .results {
      margin: 4px 0 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
    }
    .results button {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      inline-size: 100%;
      padding-block: 10px;
      padding-inline: 12px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .results button:hover,
    .results button:focus-visible {
      background: var(--mat-sys-surface-container);
    }
    small,
    .hint {
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class PersonPickerComponent {
  private readonly api = inject(ApiClient);

  readonly value = model<ConnectTarget | null>(null);

  protected readonly query = signal('');
  protected readonly results = signal<SearchResult[]>([]);
  protected readonly failed = signal(false);
  protected readonly noResults = signal(false);
  private readonly queries = new Subject<string>();

  constructor() {
    this.queries
      .pipe(
        debounceTime(SEARCH_DELAY_MS),
        switchMap((q): Observable<Outcome | null> => {
          const text = q.trim();
          if (text.length < MIN_QUERY_LENGTH) return of(null);
          return this.api.get<SearchResult[]>('/search', { q: text, limit: MAX_RESULTS }).pipe(
            map((results) => ({ results, failed: false })),
            catchError(() => of({ results: [], failed: true })),
          );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((outcome) => {
        this.results.set(outcome?.results ?? []);
        this.failed.set(outcome?.failed ?? false);
        this.noResults.set(!!outcome && !outcome.failed && outcome.results.length === 0);
      });
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.query.set(text);
    this.noResults.set(false);
    this.failed.set(false);
    this.queries.next(text);
  }

  protected detail(result: SearchResult): string {
    return [result.profession, result.city].filter(Boolean).join(' · ');
  }

  protected pick(result: SearchResult): void {
    this.value.set({ id: result.person_id, name: result.display_name });
    this.clearSearch();
  }

  protected reset(): void {
    this.value.set(null);
    this.clearSearch();
  }

  private clearSearch(): void {
    this.query.set('');
    this.results.set([]);
    this.noResults.set(false);
  }
}
