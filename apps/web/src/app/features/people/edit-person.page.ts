import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { PersonOut } from '@connections/domain-types';
import type { Observable } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { PersonFormComponent } from './person-form.component';
import { type PersonFormValue, personFormValueFrom, toPersonInput } from './person-form.model';

type LoadState = 'loading' | 'ready' | 'notFound' | 'failed';

/**
 * Edit a person (`/people/:id/edit`). The API replaces the whole profile on save, so the form
 * starts from everything it holds and sends everything back. After saving it goes to the person.
 */
@Component({
  selector: 'app-edit-person-page',
  imports: [MatButtonModule, TranslatePipe, PersonFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.edit.title' | translate }}</h1>

    @switch (state()) {
      @case ('loading') {
        <p role="status">{{ 'common.loading' | translate }}</p>
      }
      @case ('notFound') {
        <p class="error" role="alert">{{ 'person.errors.notFound' | translate }}</p>
      }
      @case ('failed') {
        <p class="error" role="alert">{{ 'person.edit.loadFailed' | translate }}</p>
        <button mat-stroked-button type="button" class="retry" (click)="load()">
          {{ 'common.retry' | translate }}
        </button>
      }
      @case ('ready') {
        <app-person-form
          mode="edit"
          [draftKey]="'edit-person:' + id"
          [initial]="initial()"
          [submitter]="submit"
          (saved)="onSaved()"
        />
      }
    }
  `,
  styles: `
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class EditPersonPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  protected readonly state = signal<LoadState>('loading');
  private readonly person = signal<PersonOut | null>(null);
  protected readonly initial = computed(() => {
    const person = this.person();
    return person ? personFormValueFrom(person) : null;
  });

  protected readonly submit = (value: PersonFormValue): Observable<PersonOut> =>
    this.api.put<PersonOut>(this.path(), toPersonInput(value));

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.api.get<PersonOut>(this.path()).subscribe({
      next: (person) => {
        this.person.set(person);
        this.state.set('ready');
      },
      error: (failure: unknown) =>
        this.state.set(toApiError(failure).code === 'not_found' ? 'notFound' : 'failed'),
    });
  }

  protected onSaved(): void {
    void this.router.navigateByUrl(`/people/${encodeURIComponent(this.id)}`);
  }

  private path(): string {
    return `/people/${encodeURIComponent(this.id)}`;
  }
}
