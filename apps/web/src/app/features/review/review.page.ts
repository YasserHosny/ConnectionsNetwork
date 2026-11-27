import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

interface Tab {
  path: string;
  cssClass: string;
  labelKey: string;
}

/**
 * /review: the three lists that keep the network tidy (spec 8.4, 8.8, 9), one section each. Each
 * section is its own route, so a list is fetched only when it is opened.
 */
@Component({
  selector: 'app-review-page',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.review.title' | translate }}</h1>
    <nav class="tabs" [attr.aria-label]="'review.tabsLabel' | translate">
      @for (tab of tabs; track tab.path) {
        <a
          class="tab"
          [class]="tab.cssClass"
          [routerLink]="tab.path"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
        >
          {{ tab.labelKey | translate }}
        </a>
      }
    </nav>
    <router-outlet />
  `,
  styles: `
    :host {
      display: block;
    }
    h1 {
      margin-block-start: 0;
    }
    .tabs {
      display: flex;
      gap: 4px;
      margin-block-end: 16px;
      overflow-x: auto;
      border-block-end: 1px solid var(--mat-sys-outline-variant);
    }
    .tab {
      flex: none;
      padding-block: 10px;
      padding-inline: 16px;
      border-block-end: 3px solid transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      text-decoration: none;
      white-space: nowrap;
    }
    /* On a phone the three tabs share the row and their labels wrap, so none is out of sight. */
    @media (max-width: 719px) {
      .tab {
        flex: 1 1 0;
        padding-inline: 8px;
        white-space: normal;
        text-align: center;
      }
    }
    .tab.active {
      border-block-end-color: var(--mat-sys-primary);
      color: var(--mat-sys-primary);
    }
  `,
})
export class ReviewPage {
  protected readonly tabs: readonly Tab[] = [
    { path: 'duplicates', cssClass: 'tab-duplicates', labelKey: 'review.tabs.duplicates' },
    { path: 'stale', cssClass: 'tab-stale', labelKey: 'review.tabs.stale' },
    { path: 'unreachable', cssClass: 'tab-unreachable', labelKey: 'review.tabs.unreachable' },
  ];
}
