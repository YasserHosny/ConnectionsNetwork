import { ChangeDetectionStrategy, Component, DestroyRef, InjectionToken, effect, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';

import { AppUpdates } from '../core/app-updates';

/** Reloads the page (a token so tests do not reload the test runner). */
export const RELOAD_PAGE = new InjectionToken<() => void>('RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => () => document.location.reload(),
});

/** Long enough for a screen reader to register the empty status region before its message. */
const ANNOUNCE_DELAY_MS = 150;

/**
 * Says when a new version of the app has been downloaded, and reloads into it when asked.
 *
 * The service worker keeps serving the cached app until the next load, so without this a deploy
 * reached a returning visitor only on their second visit. It never reloads by itself, and reloads
 * directly when asked (a reload picks up the ready version; waiting on the worker could hang if it
 * is in safe mode). An entry being typed or saved is kept as a draft, so a reload loses nothing.
 *
 * The status region is always there and filled a moment after the banner appears: a region that
 * arrives already holding its message can go unannounced (NVDA). The buttons sit outside it.
 */
@Component({
  selector: 'app-update-banner',
  imports: [MatButtonModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="visually-hidden" role="status">
      @if (announced()) {
        {{ 'common.update.ready' | translate }}
      }
    </p>
    @if (updates.ready()) {
      <div class="update-banner">
        <span aria-hidden="true">{{ 'common.update.ready' | translate }}</span>
        <button mat-button type="button" class="later" (click)="updates.dismiss()">
          {{ 'common.update.later' | translate }}
        </button>
        <button mat-flat-button type="button" class="reload" (click)="reload()">
          {{ 'common.update.reload' | translate }}
        </button>
      </div>
    }
  `,
  styles: `
    .update-banner {
      position: fixed;
      inset-block-end: 16px;
      inset-inline: 16px;
      z-index: 1000;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      max-inline-size: 480px;
      margin-inline: auto;
      padding-block: 8px;
      padding-inline: 16px 8px;
      border-radius: 12px;
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      box-shadow: var(--mat-sys-level3);
    }
    .update-banner span {
      flex: 1 1 auto;
    }
    .later {
      --mat-button-text-label-text-color: var(--mat-sys-inverse-on-surface);
    }
    .reload {
      --mat-button-filled-container-color: var(--mat-sys-inverse-primary);
      --mat-button-filled-label-text-color: var(--mat-sys-on-primary-fixed);
    }
    /* Above the bottom navigation on a phone. */
    @media (max-width: 719px) {
      .update-banner {
        inset-block-end: 88px;
      }
    }
  `,
})

export class UpdateBannerComponent {
  protected readonly updates = inject(AppUpdates);
  private readonly reloadPage = inject(RELOAD_PAGE);

  protected readonly announced = signal(false);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const ready = this.updates.ready();
      // Room at the bottom of the page, so the banner never covers the last control (Save).
      document.body.classList.toggle('update-banner-open', ready);
      clearTimeout(timer);
      if (ready) timer = setTimeout(() => this.announced.set(true), ANNOUNCE_DELAY_MS);
      else this.announced.set(false);
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      document.body.classList.remove('update-banner-open');
    });
  }

  protected reload(): void {
    this.reloadPage();
  }
}
