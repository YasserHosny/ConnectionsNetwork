import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

import { IsolatePipe } from '../../core/bidi';

export interface DeletePersonDialogData {
  name: string;
}

/** "Delete <name>?": closes with true only when the admin confirms. */
@Component({
  selector: 'app-delete-person-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe, IsolatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ 'person.view.deleteDialog.title' | translate: { name: (data.name | isolate) } }}</h2>
    <mat-dialog-content>{{ 'person.view.deleteDialog.body' | translate }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="dialog-cancel" [mat-dialog-close]="false" cdkFocusInitial>
        {{ 'person.view.deleteDialog.cancel' | translate }}
      </button>
      <button mat-flat-button type="button" class="dialog-confirm" [mat-dialog-close]="true">
        {{ 'person.view.deleteDialog.confirm' | translate }}
      </button>
    </mat-dialog-actions>
  `,
})
export class DeletePersonDialog {
  protected readonly data = inject<DeletePersonDialogData>(MAT_DIALOG_DATA);
}
