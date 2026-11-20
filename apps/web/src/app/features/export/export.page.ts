import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ExportFormat } from '@connections/domain-types';

import { ApiClient, toApiError } from '../../core/api.client';
import { saveBlob } from '../../core/file-download';
import { actionErrorKey, isMfaRequired } from '../people/person-errors';

/**
 * Export (spec 9): everything in the network, whenever the admin wants it. JSON is the full
 * backup; CSV is a zip of one file per table, with formula-looking cells neutralised.
 */
@Component({
  selector: 'app-export-page',
  imports: [MatButtonModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ 'pages.export.title' | translate }}</h1>
    <p class="intro">{{ 'export.intro' | translate }}</p>

    <div class="formats">
      <section class="format">
        <h2>{{ 'export.json.title' | translate }}</h2>
        <p class="hint">{{ 'export.json.hint' | translate }}</p>
        <button mat-flat-button type="button" class="download-json" [disabled]="busy() !== null" (click)="download('json')">
          {{ (busy() === 'json' ? 'export.json.working' : 'export.json.button') | translate }}
        </button>
      </section>

      <section class="format">
        <h2>{{ 'export.csv.title' | translate }}</h2>
        <p class="hint">{{ 'export.csv.hint' | translate }}</p>
        <button mat-stroked-button type="button" class="download-csv" [disabled]="busy() !== null" (click)="download('csv')">
          {{ (busy() === 'csv' ? 'export.csv.working' : 'export.csv.button') | translate }}
        </button>
      </section>
    </div>

    @if (downloaded(); as filename) {
      <p class="status" role="status">{{ 'export.done' | translate: { filename } }}</p>
    }
    @if (error(); as key) {
      <p class="error" role="alert">{{ key | translate }}</p>
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
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    p {
      margin: 0;
    }
    .intro,
    .hint {
      color: var(--mat-sys-on-surface-variant);
    }
    .intro {
      margin-block-end: 16px;
    }
    .formats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .format {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
    }
    .status,
    .error {
      margin-block-start: 16px;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class ExportPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  protected readonly busy = signal<ExportFormat | null>(null);
  protected readonly downloaded = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async download(format: ExportFormat): Promise<void> {
    this.busy.set(format);
    this.downloaded.set(null);
    this.error.set(null);
    try {
      const file = await this.api.download('/export', { format });
      saveBlob(this.document, file.blob, file.filename);
      this.downloaded.set(file.filename);
    } catch (failure) {
      const error = toApiError(failure);
      if (isMfaRequired(error)) void this.router.navigateByUrl('/mfa');
      else this.error.set(actionErrorKey(error));
    } finally {
      this.busy.set(null);
    }
  }
}
