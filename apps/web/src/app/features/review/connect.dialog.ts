import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import type { ConnectionIn, Strength } from '@connections/domain-types';

import { ApiClient, toApiError } from '../../core/api.client';
import { AuthService } from '../../core/auth.service';
import { PersonPickerComponent } from '../people/person-picker.component';
import { actionErrorKey } from '../people/person-errors';
import { type ConnectTarget, STRENGTH_OPTIONS } from '../people/person-form.model';

export interface ConnectDialogData {
  /** The person nobody can reach: one end of the new connection. */
  person: ConnectTarget;
}

/**
 * "Connect…" on an unreachable person (spec 9): pick who they are connected to (the admin unless
 * someone else is chosen) and how strongly, then `POST /connections`. Closes with true once the
 * connection exists.
 */
@Component({
  selector: 'app-connect-dialog',
  imports: [MatButtonModule, MatDialogModule, MatRadioModule, TranslatePipe, PersonPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ 'review.unreachable.dialog.title' | translate: { name: data.person.name } }}</h2>
    <mat-dialog-content>
      <app-person-picker [(value)]="target" />

      <fieldset class="strength">
        <legend>{{ 'person.strength.label' | translate }}</legend>
        <mat-radio-group class="strength-options" [value]="strength()" (change)="strength.set($event.value)">
          @for (option of strengths; track option.value) {
            <mat-radio-button [value]="option.value" [attr.value]="option.value">
              {{ option.labelKey | translate }}
            </mat-radio-button>
          }
        </mat-radio-group>
        <p class="hint">{{ 'person.strength.help' | translate }}</p>
        @if (submitAttempted() && !strength()) {
          <p class="field-error" role="alert">{{ 'person.errors.strengthRequired' | translate }}</p>
        }
      </fieldset>

      @if (error(); as key) {
        <p class="dialog-error" role="alert">{{ key | translate: { name: data.person.name } }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="dialog-cancel" [disabled]="busy()" [mat-dialog-close]="false">
        {{ 'review.unreachable.dialog.cancel' | translate }}
      </button>
      <button mat-flat-button type="button" class="dialog-submit" [disabled]="busy()" (click)="submit()">
        {{ (busy() ? 'review.unreachable.dialog.submitting' : 'review.unreachable.dialog.submit') | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .strength {
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
    legend {
      padding: 0;
      font: var(--mat-sys-title-small);
    }
    .strength-options {
      display: flex;
      flex-wrap: wrap;
      gap: 0 16px;
    }
    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .field-error,
    .dialog-error {
      margin: 8px 0 0;
      color: var(--mat-sys-error);
    }
  `,
})
export class ConnectDialog {
  protected readonly data = inject<ConnectDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ConnectDialog, boolean>>(MatDialogRef);
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);

  protected readonly strengths = STRENGTH_OPTIONS;
  /** `null` is the admin, like on the add form. */
  protected readonly target = signal<ConnectTarget | null>(null);
  protected readonly strength = signal<Strength | null>(null);
  protected readonly submitAttempted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(): void {
    this.submitAttempted.set(true);
    const strength = this.strength();
    if (!strength) return;

    const other = this.target()?.id ?? this.auth.personId();
    if (!other) {
      this.error.set('person.errors.sessionEnded');
      return;
    }
    if (other === this.data.person.id) {
      this.error.set('review.unreachable.dialog.self');
      return;
    }

    const body: ConnectionIn = { person_a: this.data.person.id, person_b: other, strength };
    this.busy.set(true);
    this.error.set(null);
    this.api.post('/connections', body).subscribe({
      next: () => this.ref.close(true),
      error: (failure: unknown) => {
        this.busy.set(false);
        this.error.set(actionErrorKey(toApiError(failure)));
      },
    });
  }
}
