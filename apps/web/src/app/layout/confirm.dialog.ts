import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

/** What to ask: i18n keys (the title and body may use `params`), never raw text. */
export interface ConfirmDialogData {
  titleKey: string;
  bodyKey: string;
  confirmKey: string;
  params?: Record<string, string>;
  /** The action deletes or ends something (merge, revoke, remove): the confirm button says so. */
  destructive?: boolean;
}

/**
 * A yes/no question for an action that cannot be undone (merge, revoke). Closes with true only
 * when the admin confirms; the safe choice, Cancel, has the focus.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.titleKey | translate: data.params }}</h2>
    <mat-dialog-content class="confirm-body">{{ data.bodyKey | translate: data.params }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="dialog-cancel" [mat-dialog-close]="false" cdkFocusInitial>
        {{ 'common.cancel' | translate }}
      </button>
      <button
        mat-flat-button
        type="button"
        class="dialog-confirm"
        [class.danger]="data.destructive"
        [mat-dialog-close]="true"
      >
        {{ data.confirmKey | translate }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
