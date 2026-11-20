import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { CreateLinkRequest, IssuedLink, LinkOut } from '@connections/domain-types';

import { ApiClient, toApiError } from '../../core/api.client';
import { formatDate } from '../../core/format-date';
import { LocaleService } from '../../core/locale.service';
import { ConfirmDialog, type ConfirmDialogData } from '../../layout/confirm.dialog';
import { actionErrorKey, isMfaRequired } from '../people/person-errors';
import type { ConnectTarget } from '../people/person-form.model';
import { PersonPickerComponent } from '../people/person-picker.component';
import { LinkIssuedDialog, type LinkIssuedDialogData } from './link-issued.dialog';

type LoadState = 'loading' | 'ready' | 'failed';
type LinkStatus = 'active' | 'expired' | 'revoked';
type Action = 'create' | 'renew' | 'revoke';

const STATUS_KEYS: Record<LinkStatus, string> = {
  active: 'links.status.active',
  expired: 'links.status.expired',
  revoked: 'links.status.revoked',
};

/** What the line under the name says for each status: when it ends, ended, or was revoked. */
const DATE_KEYS: Record<LinkStatus, string> = {
  active: 'links.expiresOn',
  expired: 'links.expiredOn',
  revoked: 'links.revokedOn',
};

/**
 * Contributor links (spec 8.2): create one for a person, renew an expired one with a click,
 * revoke one at any time. The URL a create or a renew returns goes straight into the dialog that
 * shows it once; this page never stores it (not in a field, storage or the address bar), and the
 * list from the API has no URL, so it cannot be shown again.
 */
@Component({
  selector: 'app-links-page',
  imports: [MatButtonModule, RouterLink, TranslatePipe, PersonPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.links.title' | translate }}</h1>
    <p class="intro">{{ 'links.intro' | translate }}</p>

    <section class="create-box">
      <app-person-picker
        legendKey="links.create.legend"
        emptyKey="links.create.empty"
        resetKey="links.create.reset"
        [(value)]="target"
      />
      <button
        mat-flat-button
        type="button"
        class="create"
        [disabled]="!target() || busy() !== null"
        (click)="create()"
      >
        {{ (busy()?.action === 'create' ? 'links.create.submitting' : 'links.create.submit') | translate }}
      </button>
    </section>

    @if (error(); as key) {
      <p class="error" role="alert">{{ key | translate }}</p>
    }

    <h2>{{ 'links.listTitle' | translate }}</h2>
    @switch (state()) {
      @case ('loading') {
        <p role="status">{{ 'common.loading' | translate }}</p>
      }
      @case ('failed') {
        <p class="load-error error" role="alert">{{ 'links.loadFailed' | translate }}</p>
        <button mat-stroked-button type="button" class="retry" (click)="load()">
          {{ 'common.retry' | translate }}
        </button>
      }
      @case ('ready') {
        @if (links().length === 0) {
          <p class="empty">{{ 'links.empty' | translate }}</p>
        }
        <ul class="links">
          @for (link of links(); track link.link_id) {
            <li class="link" [attr.data-link-id]="link.link_id">
              <div class="info">
                <span class="title">
                  <a class="name" [routerLink]="['/people', link.person_id]">{{ link.display_name }}</a>
                  <span class="status" [class]="'status status-' + statusOf(link)">{{ statusKey(link) | translate }}</span>
                </span>
                <span class="detail">{{ dateKey(link) | translate: { date: dateOf(link) } }}</span>
                <span class="detail added">{{ 'links.peopleAdded' | translate: { count: link.people_added } }}</span>
              </div>
              <div class="actions">
                @if (statusOf(link) !== 'revoked') {
                  <button
                    mat-stroked-button
                    type="button"
                    class="renew"
                    [disabled]="busy() !== null"
                    (click)="renew(link)"
                  >
                    {{ (isBusy(link, 'renew') ? 'links.renewing' : 'links.renew') | translate }}
                  </button>
                }
                @if (statusOf(link) === 'active') {
                  <button
                    mat-stroked-button
                    type="button"
                    class="revoke"
                    [disabled]="busy() !== null"
                    (click)="revoke(link)"
                  >
                    {{ (isBusy(link, 'revoke') ? 'links.revoking' : 'links.revoke') | translate }}
                  </button>
                }
              </div>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 900px;
    }
    h1 {
      margin-block-start: 0;
    }
    h2 {
      margin-block: 24px 8px;
      font: var(--mat-sys-title-medium);
    }
    p {
      margin: 0;
    }
    .intro,
    .empty,
    .detail {
      color: var(--mat-sys-on-surface-variant);
    }
    .intro {
      margin-block-end: 16px;
    }
    .create-box {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
    }
    app-person-picker {
      inline-size: 100%;
    }
    .error {
      margin-block-start: 12px;
      color: var(--mat-sys-error);
    }
    .links {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .link {
      display: grid;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
    }
    .info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-inline-size: 0;
    }
    .title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .name {
      font: var(--mat-sys-title-medium);
      color: inherit;
    }
    .status {
      padding-block: 2px;
      padding-inline: 8px;
      border-radius: 8px;
      font: var(--mat-sys-label-small);
    }
    .status-active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .status-expired {
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }
    .status-revoked {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    @media (min-width: 700px) {
      .link {
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
      }
    }
  `,
})
export class LinksPage {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly locale = inject(LocaleService);

  protected readonly state = signal<LoadState>('loading');
  protected readonly links = signal<LinkOut[]>([]);
  /** When the list was read: a link's status is judged against this, not a clock that ticks. */
  private readonly now = signal(Date.now());
  protected readonly target = signal<ConnectTarget | null>(null);
  protected readonly busy = signal<{ id: string | null; action: Action } | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.fetch();
  }

  /** Revoked wins; otherwise it is expired once its time has passed. */
  protected statusOf(link: LinkOut): LinkStatus {
    if (link.revoked_at) return 'revoked';
    return new Date(link.expires_at).getTime() <= this.now() ? 'expired' : 'active';
  }

  protected statusKey(link: LinkOut): string {
    return STATUS_KEYS[this.statusOf(link)];
  }

  protected dateKey(link: LinkOut): string {
    return DATE_KEYS[this.statusOf(link)];
  }

  protected dateOf(link: LinkOut): string {
    return formatDate(link.revoked_at ?? link.expires_at, this.locale.locale());
  }

  protected isBusy(link: LinkOut, action: Action): boolean {
    const current = this.busy();
    return current?.id === link.link_id && current.action === action;
  }

  protected create(): void {
    const person = this.target();
    if (!person) return;
    const body: CreateLinkRequest = { person_id: person.id };
    this.begin(null, 'create');
    this.api.post<IssuedLink>('/links', body).subscribe({
      next: (issued) => {
        this.busy.set(null);
        this.target.set(null);
        this.showIssued(person.name, issued);
        this.fetch();
      },
      error: (failure: unknown) => this.fail(failure, false),
    });
  }

  protected renew(link: LinkOut): void {
    this.begin(link, 'renew');
    this.api.post<IssuedLink>(`/links/${encodeURIComponent(link.link_id)}/renew`).subscribe({
      next: (issued) => {
        this.busy.set(null);
        this.showIssued(link.display_name, issued);
        this.fetch();
      },
      error: (failure: unknown) => this.fail(failure, true),
    });
  }

  protected revoke(link: LinkOut): void {
    const data: ConfirmDialogData = {
      titleKey: 'links.revokeDialog.title',
      bodyKey: 'links.revokeDialog.body',
      confirmKey: 'links.revokeDialog.confirm',
      params: { name: link.display_name },
    };
    this.dialog
      .open(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((confirmed: boolean | undefined) => {
        if (confirmed === true) this.doRevoke(link);
      });
  }

  private doRevoke(link: LinkOut): void {
    this.begin(link, 'revoke');
    this.api.post<LinkOut>(`/links/${encodeURIComponent(link.link_id)}/revoke`).subscribe({
      next: (revoked) => {
        this.busy.set(null);
        this.links.update((links) => links.map((l) => (l.link_id === revoked.link_id ? revoked : l)));
      },
      error: (failure: unknown) => this.fail(failure, true),
    });
  }

  /** Hands the URL to the dialog and keeps no copy: it is shown once and cannot be fetched again. */
  private showIssued(name: string, issued: IssuedLink): void {
    const data: LinkIssuedDialogData = { name, url: issued.url, expiresAt: issued.expires_at };
    this.dialog.open(LinkIssuedDialog, { data });
  }

  private begin(link: LinkOut | null, action: Action): void {
    this.busy.set({ id: link?.link_id ?? null, action });
    this.error.set(null);
  }

  private fail(failure: unknown, refreshList: boolean): void {
    const error = toApiError(failure);
    this.busy.set(null);
    if (isMfaRequired(error)) {
      void this.router.navigateByUrl('/mfa');
      return;
    }
    this.error.set(actionErrorKey(error, 'links.errors.notFound'));
    // The link was revoked or deleted elsewhere: show what is true now.
    if (refreshList && (error.code === 'link_revoked' || error.code === 'not_found')) this.fetch();
  }

  /** Reads the list without hiding the page, so the dialog and messages stay where they are. */
  private fetch(): void {
    this.api.get<LinkOut[]>('/links').subscribe({
      next: (links) => {
        this.now.set(Date.now());
        this.links.set(links);
        this.state.set('ready');
      },
      error: (failure: unknown) => {
        if (isMfaRequired(toApiError(failure))) void this.router.navigateByUrl('/mfa');
        this.state.set('failed');
      },
    });
  }
}
