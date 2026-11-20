import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, model, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { SkillCategory, SkillLevel, TagKind } from '@connections/domain-types';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';

import {
  SKILL_CATEGORY_OPTIONS,
  SKILL_LEVEL_OPTIONS,
  type TagSuggest,
  type TagSuggestion,
  type TagValue,
} from './person-form.model';

const SUGGEST_DELAY_MS = 300;

/**
 * Free-text tags with autocomplete. A skill needs a category (chosen here, or taken from the
 * suggestion that was picked) and may carry a level, set on its chip; an industry is a label only.
 *
 * `suggest` is injected as an input so the contributor page (Task 16) can reuse this with
 * `/contribute/tags` instead of the admin's `/tags`.
 */
@Component({
  selector: 'app-tag-input',
  imports: [
    MatAutocompleteModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (value().length) {
      <ul class="chips">
        @for (tag of value(); track tag.label; let i = $index) {
          <li class="chip">
            <span class="chip-label">{{ tag.label }}</span>
            @if (tag.category) {
              <span class="chip-category">{{ categoryKey(tag.category) | translate }}</span>
            }
            @if (kind() === 'skill') {
              <select
                class="level"
                [attr.aria-label]="'person.skillLevel.label' | translate"
                (change)="setLevel(i, $event)"
              >
                <option value="" [selected]="!tag.level">{{ 'person.skillLevel.none' | translate }}</option>
                @for (option of levels; track option.value) {
                  <option [value]="option.value" [selected]="tag.level === option.value">
                    {{ option.labelKey | translate }}
                  </option>
                }
              </select>
            }
            <button
              type="button"
              class="remove"
              [attr.aria-label]="'person.tags.remove' | translate: { label: tag.label }"
              (click)="remove(i)"
            >
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          </li>
        }
      </ul>
    }

    <div class="entry">
      <mat-form-field appearance="outline" subscriptSizing="dynamic" class="text">
        <mat-label>{{ labelKey() | translate }}</mat-label>
        <input
          matInput
          autocomplete="off"
          [matAutocomplete]="auto"
          [value]="text()"
          (input)="onInput($event)"
          (focus)="queries.next(text())"
          (keydown.enter)="onEnter($event)"
        />
        <mat-autocomplete #auto="matAutocomplete" (optionSelected)="onOptionSelected($event.option.value)">
          @for (s of suggestions(); track s.label) {
            <mat-option [value]="s.label">
              {{ s.label }}
              @if (s.category) {
                <small class="option-category">{{ categoryKey(s.category) | translate }}</small>
              }
            </mat-option>
          }
        </mat-autocomplete>
      </mat-form-field>

      @if (kind() === 'skill') {
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="category-field">
          <mat-label>{{ 'person.tags.categoryLabel' | translate }}</mat-label>
          <select matNativeControl class="category" (change)="onCategory($event)">
            <option value="" [selected]="!category()">{{ 'person.tags.categoryPlaceholder' | translate }}</option>
            @for (option of categories; track option.value) {
              <option [value]="option.value" [selected]="category() === option.value">
                {{ option.labelKey | translate }}
              </option>
            }
          </select>
        </mat-form-field>
      }

      <button mat-stroked-button type="button" class="add" (click)="add()">
        {{ 'person.tags.add' | translate }}
      </button>
    </div>

    @if (categoryMissing()) {
      <p class="error" role="alert">{{ 'person.tags.categoryRequired' | translate }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-block: 4px;
      padding-inline: 12px 4px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 16px;
      background: var(--mat-sys-surface-container);
    }
    .chip-category {
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.8rem;
    }
    .level {
      max-inline-size: 7rem;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .remove {
      display: grid;
      place-items: center;
      padding: 2px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .entry {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
    }
    .text {
      flex: 1 1 14rem;
    }
    .category-field {
      flex: 1 1 10rem;
    }
    .add {
      min-block-size: 56px;
    }
    .option-category {
      margin-inline-start: 8px;
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      margin-block: 4px 0;
      color: var(--mat-sys-error);
    }
  `,
})
export class TagInputComponent {
  readonly kind = input.required<TagKind>();
  readonly suggest = input.required<TagSuggest>();
  /** i18n key of the input's label. */
  readonly labelKey = input('person.form.skills');
  readonly value = model<TagValue[]>([]);

  protected readonly categories = SKILL_CATEGORY_OPTIONS;
  protected readonly levels = SKILL_LEVEL_OPTIONS;
  protected readonly text = signal('');
  protected readonly category = signal<SkillCategory | null>(null);
  protected readonly suggestions = signal<TagSuggestion[]>([]);
  protected readonly categoryMissing = signal(false);
  protected readonly queries = new Subject<string>();

  private readonly trigger = viewChild(MatAutocompleteTrigger);

  constructor() {
    this.queries
      .pipe(
        debounceTime(SUGGEST_DELAY_MS),
        switchMap((q) =>
          this.suggest()(this.kind(), q.trim()).pipe(catchError(() => of<TagSuggestion[]>([]))),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((found) => this.suggestions.set(found));
  }

  protected categoryKey(category: SkillCategory): string {
    return SKILL_CATEGORY_OPTIONS.find((o) => o.value === category)?.labelKey ?? '';
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.text.set(text);
    this.queries.next(text);
  }

  protected onCategory(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.category.set((value || null) as SkillCategory | null);
    this.categoryMissing.set(false);
  }

  /** A picked suggestion that is complete (an industry, or a skill with its category) is added. */
  protected onOptionSelected(label: string): void {
    const suggestion = this.suggestions().find((s) => s.label === label);
    if (!suggestion) return;
    this.applySuggestion(suggestion);
    if (this.kind() === 'industry' || suggestion.category) this.add();
  }

  /**
   * On save: adds what is typed but not yet added, when that needs nothing more. Returns the text
   * it could not add (a skill with no category, which is then flagged here), or null.
   */
  commitPending(): string | null {
    const label = this.text().trim();
    if (!label) return null;
    this.add();
    return this.text().trim() ? label : null;
  }

  /** A picked suggestion fills in the text and the category it is filed under. */
  protected applySuggestion(suggestion: TagSuggestion): void {
    this.text.set(suggestion.label);
    if (this.kind() === 'skill' && suggestion.category) this.category.set(suggestion.category);
    this.categoryMissing.set(false);
  }

  protected onEnter(event: Event): void {
    // Enter must not submit the whole form; with an option highlighted it picks that option.
    event.preventDefault();
    if (this.trigger()?.activeOption) return;
    this.add();
  }

  protected add(): void {
    const label = this.text().trim();
    if (!label) return;
    const isSkill = this.kind() === 'skill';
    const category = isSkill ? this.category() : null;
    if (isSkill && !category) {
      this.categoryMissing.set(true);
      return;
    }
    const known = this.value().some((t) => t.label.toLowerCase() === label.toLowerCase());
    if (!known) this.value.update((tags) => [...tags, { label, category, level: null }]);
    this.text.set('');
    this.category.set(null);
    this.categoryMissing.set(false);
    this.suggestions.set([]);
  }

  protected remove(index: number): void {
    this.value.update((tags) => tags.filter((_, i) => i !== index));
  }

  protected setLevel(index: number, event: Event): void {
    const level = ((event.target as HTMLSelectElement).value || null) as SkillLevel | null;
    this.value.update((tags) => tags.map((t, i) => (i === index ? { ...t, level } : t)));
  }
}
