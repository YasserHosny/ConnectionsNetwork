import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthService } from '../core/auth.service';
import { LanguageSwitchComponent } from './language-switch.component';

interface NavItem {
  path: string;
  icon: string;
  labelKey: string;
}

/**
 * The signed-in frame: a top bar (app name, language switch, sign out) over a side navigation on
 * wide screens and a bottom navigation on phones. Pages render in the outlet.
 */
@Component({
  selector: 'app-shell',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatToolbarModule,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslatePipe,
    LanguageSwitchComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">{{ 'shell.skipToContent' | translate }}</a>

    <header class="top-bar-host">
      <mat-toolbar class="top-bar">
        <span class="app-name">{{ 'common.appName' | translate }}</span>
        <span class="spacer"></span>
        <app-language-switch />
        <button mat-button type="button" class="sign-out" [attr.aria-label]="'shell.signOut' | translate" (click)="signOut()">
          <mat-icon aria-hidden="true">logout</mat-icon>
          <span class="sign-out-label">{{ 'shell.signOut' | translate }}</span>
        </button>
      </mat-toolbar>
    </header>

    <nav class="nav" [attr.aria-label]="'shell.navLabel' | translate">
      @for (item of navItems; track item.path) {
        <a class="nav-link" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
          <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
          <span class="nav-label">{{ item.labelKey | translate }}</span>
        </a>
      }
    </nav>

    <main id="main-content" class="content" tabindex="-1">
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto 1fr;
      grid-template-areas:
        'top top'
        'nav content';
      min-block-size: 100dvh;
    }

    .skip-link {
      position: absolute;
      inset-inline-start: 8px;
      inset-block-start: -48px;
      z-index: 20;
      padding: 8px 12px;
      border-radius: 4px;
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .skip-link:focus {
      inset-block-start: 8px;
    }

    /* The banner landmark: the grid's top row, sticky while the page scrolls. */
    .top-bar-host {
      grid-area: top;
      position: sticky;
      inset-block-start: 0;
      z-index: 10;
    }
    .top-bar {
      gap: 4px;
    }
    /* On a phone the sign-out button is its icon (it keeps its label for screen readers), so the
       app name is not cut short. */
    @media (max-width: 719px) {
      .sign-out-label {
        display: none;
      }
    }
    .app-name {
      min-inline-size: 0;
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .spacer {
      flex: 1 1 auto;
    }

    .nav {
      grid-area: nav;
      display: flex;
      flex-direction: column;
      gap: 4px;
      inline-size: 220px;
      padding: 12px;
      border-inline-end: 1px solid var(--mat-sys-outline-variant);
    }
    .nav-link {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-block: 10px;
      padding-inline: 12px;
      border-radius: 20px;
      color: var(--mat-sys-on-surface-variant);
      text-decoration: none;
    }
    .nav-link.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font-weight: 600;
    }

    .content {
      grid-area: content;
      min-inline-size: 0;
      padding: 16px;
      outline: none;
    }

    @media (max-width: 719px) {
      :host {
        // minmax(0, ...) lets the column shrink below its content: a long Arabic app name, the
        // language switch and sign out together are wider than a 375px phone.
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
          'top'
          'content';
        padding-block-end: 64px;
      }
      .nav {
        position: fixed;
        inset-inline: 0;
        inset-block-end: 0;
        z-index: 10;
        flex-direction: row;
        justify-content: space-around;
        inline-size: auto;
        gap: 0;
        padding: 4px;
        border-inline-end: 0;
        border-block-start: 1px solid var(--mat-sys-outline-variant);
        background: var(--mat-sys-surface);
      }
      .nav-link {
        flex: 1 1 0;
        flex-direction: column;
        gap: 2px;
        min-inline-size: 0;
        padding-block: 6px;
        padding-inline: 4px;
        border-radius: 12px;
        font-size: 0.75rem;
        text-align: center;
      }
      .nav-label {
        max-inline-size: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  `,
})
export class ShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly navItems: readonly NavItem[] = [
    { path: '/search', icon: 'search', labelKey: 'shell.nav.search' },
    { path: '/add', icon: 'person_add', labelKey: 'shell.nav.add' },
    { path: '/review', icon: 'fact_check', labelKey: 'shell.nav.review' },
    { path: '/links', icon: 'link', labelKey: 'shell.nav.links' },
    { path: '/export', icon: 'download', labelKey: 'shell.nav.export' },
  ];

  constructor() {
    // The session can end while a page is open: signed out in another tab, a refresh token that
    // was revoked or expired. Nothing behind the shell works without one.
    effect(() => {
      if (!this.auth.session()) void this.router.navigateByUrl('/login');
    });
  }

  protected async signOut(): Promise<void> {
    // Leaving the page must not depend on the sign-out call succeeding.
    await this.auth.signOut().catch((error: unknown) => console.error('[auth] sign-out failed', error));
    await this.router.navigateByUrl('/login');
  }
}
