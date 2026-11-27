import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthError, AuthService } from '../../core/auth.service';
import { safeReturn, withReturn } from '../../core/return-to';
import { LanguageSwitchComponent } from '../../layout/language-switch.component';

type Mode = 'loading' | 'enroll' | 'verify' | 'failed';

/**
 * The TOTP step after the password. A person with no verified authenticator first enrols one
 * (QR code, then a code from it); otherwise they just enter a code. Either way it ends at aal2.
 */
@Component({
  selector: 'app-mfa',
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

      @switch (mode()) {
        @case ('loading') {
          <p role="status">{{ 'auth.mfa.loading' | translate }}</p>
        }
        @case ('enroll') {
          <h1>{{ 'auth.mfa.enroll.title' | translate }}</h1>
          <p>{{ 'auth.mfa.enroll.intro' | translate }}</p>
          @if (qrCode(); as qr) {
            <img class="qr" [src]="qr" [alt]="'auth.mfa.enroll.qrAlt' | translate" />
          }
          <p>{{ 'auth.mfa.enroll.secretLabel' | translate }}</p>
          <code class="secret" dir="ltr">{{ secret() }}</code>
        }
        @case ('verify') {
          <h1>{{ 'auth.mfa.verify.title' | translate }}</h1>
          <p>{{ 'auth.mfa.verify.intro' | translate }}</p>
        }
        @case ('failed') {
          <p class="error" role="alert">{{ 'auth.mfa.errors.generic' | translate }}</p>
          <button mat-stroked-button type="button" (click)="load()">
            {{ 'common.retry' | translate }}
          </button>
        }
      }

      @if (mode() === 'enroll' || mode() === 'verify') {
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <mat-form-field appearance="outline">
            <mat-label>{{ 'auth.mfa.code' | translate }}</mat-label>
            <input
              matInput
              dir="ltr"
              formControlName="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
            />
          </mat-form-field>

          @if (errorKey(); as key) {
            <p class="error" role="alert">{{ key | translate }}</p>
          }

          <button mat-flat-button type="submit" [disabled]="busy()">
            {{
              (busy()
                ? 'auth.mfa.verifying'
                : mode() === 'enroll'
                  ? 'auth.mfa.enroll.submit'
                  : 'auth.mfa.verify.submit'
              ) | translate
            }}
          </button>
        </form>
      }

      <button mat-button type="button" (click)="signOut()">{{ 'shell.signOut' | translate }}</button>
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
    .qr {
      display: block;
      inline-size: 200px;
      block-size: 200px;
      margin-block: 8px;
      background: #fff;
    }
    .secret {
      display: block;
      margin-block-end: 16px;
      overflow-wrap: anywhere;
    }
    .error {
      margin-block: 0 12px;
      color: var(--mat-sys-error);
    }
  `,
})
export class MfaComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** The page to go back to once verified (`?next=`, in-app paths only), else the start. */
  private returnTo(): string {
    return safeReturn(this.route.snapshot.queryParamMap.get('next'));
  }
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });
  protected readonly mode = signal<Mode>('loading');
  protected readonly qrCode = signal<SafeUrl | null>(null);
  protected readonly secret = signal('');
  protected readonly busy = signal(false);
  protected readonly errorKey = signal<string | null>(null);

  ngOnInit(): Promise<void> {
    return this.load();
  }

  protected async load(): Promise<void> {
    if (!this.auth.session()) {
      await this.router.navigateByUrl(withReturn('/login', this.route.snapshot.queryParamMap.get('next')));
      return;
    }
    this.mode.set('loading');
    try {
      const next = await this.auth.nextStep();
      if (next === 'done') {
        await this.router.navigateByUrl(this.returnTo());
      } else if (next === 'enroll') {
        const enrollment = await this.auth.enrollTotp();
        // The QR code is an SVG data URI from our own Supabase project; Angular's URL
        // sanitizer only passes raster data URIs, and an <img> never runs script.
        this.qrCode.set(this.sanitizer.bypassSecurityTrustUrl(enrollment.qrCode));
        this.secret.set(enrollment.secret);
        this.mode.set('enroll');
      } else {
        this.mode.set('verify');
      }
    } catch {
      this.mode.set('failed');
    }
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    if (this.form.invalid) {
      this.errorKey.set('auth.mfa.errors.required');
      return;
    }
    this.busy.set(true);
    this.errorKey.set(null);
    try {
      await this.auth.verifyTotp(this.form.getRawValue().code);
      await this.router.navigateByUrl(this.returnTo());
    } catch (error) {
      this.errorKey.set(
        error instanceof AuthError && error.kind === 'invalid_code'
          ? 'auth.mfa.errors.invalidCode'
          : 'auth.mfa.errors.generic',
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    // Leaving the page must not depend on the sign-out call succeeding.
    await this.auth.signOut().catch((error: unknown) => console.error('[auth] sign-out failed', error));
    await this.router.navigateByUrl('/login');
  }
}
