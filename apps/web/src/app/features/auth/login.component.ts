import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthError, AuthService } from '../../core/auth.service';
import { LanguageSwitchComponent } from '../../layout/language-switch.component';

/** Email and password. The next screen depends on TOTP: enrol, verify, or straight in. */
@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    LanguageSwitchComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <app-language-switch />
      <h1>{{ 'auth.login.title' | translate }}</h1>
      <p>{{ 'auth.login.intro' | translate }}</p>

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.login.email' | translate }}</mat-label>
          <input matInput type="email" dir="ltr" formControlName="email" autocomplete="username" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.login.password' | translate }}</mat-label>
          <input
            matInput
            type="password"
            dir="ltr"
            formControlName="password"
            autocomplete="current-password"
          />
        </mat-form-field>

        @if (errorKey(); as key) {
          <p class="error" role="alert">{{ key | translate }}</p>
        }

        <button mat-flat-button type="submit" [disabled]="busy()">
          {{ (busy() ? 'auth.login.submitting' : 'auth.login.submit') | translate }}
        </button>
      </form>
    </main>
  `,
  styles: `
    .page {
      max-inline-size: 420px;
      margin-inline: auto;
      padding: 16px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .error {
      margin-block: 0 12px;
      color: var(--mat-sys-error);
    }
  `,
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required]],
    password: ['', [Validators.required]],
  });
  protected readonly busy = signal(false);
  protected readonly errorKey = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    if (this.form.invalid) {
      this.errorKey.set('auth.login.errors.required');
      return;
    }
    const { email, password } = this.form.getRawValue();
    this.busy.set(true);
    this.errorKey.set(null);
    try {
      const next = await this.auth.signIn(email.trim(), password);
      await this.router.navigateByUrl(next === 'done' ? '/' : '/mfa');
    } catch (error) {
      this.errorKey.set(errorKeyFor(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function errorKeyFor(error: unknown): string {
  if (error instanceof AuthError) {
    if (error.kind === 'invalid_credentials') return 'auth.login.errors.invalidCredentials';
    if (error.kind === 'not_configured') return 'auth.login.errors.notConfigured';
  }
  return 'auth.login.errors.generic';
}
