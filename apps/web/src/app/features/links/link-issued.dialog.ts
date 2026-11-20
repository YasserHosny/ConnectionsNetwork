import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

import { copyText } from '../../core/clipboard';
import { formatDate } from '../../core/format-date';
import { LocaleService } from '../../core/locale.service';
import { buildLinkShareMessage, whatsappShareUrl } from './link-share';

export interface LinkIssuedDialogData {
  /** The contributor's name. */
  name: string;
  /** The link with its token. Only here, in memory, while the dialog is open. */
  url: string;
  expiresAt: string;
}

/**
 * The contributor link, shown once (spec 11.4: only the token's hash is stored, so it cannot be
 * shown again). Copy it, or share it on WhatsApp, where the admin chooses the chat. Closing the
 * dialog is the end of it: nothing keeps the URL, not storage, not the address bar.
 */
@Component({
  selector: 'app-link-issued-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ 'links.issued.title' | translate: { name: data.name } }}</h2>
    <mat-dialog-content>
      <p class="warning">{{ 'links.issued.warning' | translate: { date: expires() } }}</p>
      <label class="url-field">
        <span class="label">{{ 'links.issued.urlLabel' | translate }}</span>
        <input class="link-url" type="text" readonly dir="ltr" [value]="data.url" (focus)="selectAll($event)" />
      </label>
      <div class="actions">
        <button mat-flat-button type="button" class="copy-link" (click)="copy()">
          {{ 'links.issued.copy' | translate }}
        </button>
        <a mat-stroked-button class="share-whatsapp" target="_blank" rel="noopener noreferrer" [href]="shareUrl()">
          {{ 'links.issued.whatsapp' | translate }}
        </a>
      </div>
      @if (copyStatus(); as status) {
        <p class="copy-status" role="status">{{ status | translate }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="dialog-done" [mat-dialog-close]="true">
        {{ 'links.issued.done' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .warning {
      margin-block: 0 12px;
    }
    .url-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .label {
      font: var(--mat-sys-label-large);
    }
    .link-url {
      box-sizing: border-box;
      inline-size: 100%;
      padding: 10px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: inherit;
      font: inherit;
      text-align: start;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-block-start: 12px;
    }
    .copy-status {
      margin-block: 12px 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class LinkIssuedDialog {
  protected readonly data = inject<LinkIssuedDialogData>(MAT_DIALOG_DATA);
  private readonly locale = inject(LocaleService);

  protected readonly copyStatus = signal<string | null>(null);
  protected readonly expires = computed(() => formatDate(this.data.expiresAt, this.locale.locale()));
  protected readonly shareUrl = computed(() =>
    whatsappShareUrl(buildLinkShareMessage(this.locale.locale(), this.data.url)),
  );

  protected async copy(): Promise<void> {
    const copied = await copyText(this.data.url);
    this.copyStatus.set(copied ? 'links.issued.copied' : 'links.issued.copyFailed');
  }

  protected selectAll(event: Event): void {
    (event.target as HTMLInputElement).select();
  }
}
