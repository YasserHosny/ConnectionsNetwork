import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';

import { LocaleService } from '../core/locale.service';
import { loadCatalogues, waitFor } from '../testing/test-helpers';
import { ConfirmDialog, type ConfirmDialogData } from './confirm.dialog';

describe('ConfirmDialog', () => {
  const data: ConfirmDialogData = {
    titleKey: 'links.revokeDialog.title',
    bodyKey: 'review.duplicates.mergeDialog.body',
    confirmKey: 'links.revokeDialog.confirm',
    params: { name: 'Karim Adel', keep: 'Keeper', drop: 'Dropped' },
  };
  const dialog = () => Array.from(document.querySelectorAll('mat-dialog-container')).at(-1);
  const button = (cls: string) => dialog()?.querySelector(`button.${cls}`) as HTMLButtonElement;
  const tick = { detectChanges: () => TestBed.tick() } as Pick<ComponentFixture<unknown>, 'detectChanges'>;

  let ref: MatDialogRef<ConfirmDialog, boolean>;
  let result: Promise<boolean | undefined>;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    ref = TestBed.inject(MatDialog).open(ConfirmDialog, { data });
    result = new Promise((resolve) => ref.afterClosed().subscribe(resolve));
    await waitFor(tick, () => dialog()?.querySelector('h2')?.textContent);
  });

  afterEach(() => ref.close());

  it('shows the title and body with the params filled in, and the confirm text', () => {
    expect(dialog()?.querySelector('h2')?.textContent).toContain('Revoke the link for Karim Adel?');
    expect(dialog()?.textContent).toContain('Keeper keeps its own details');
    expect(button('dialog-confirm').textContent).toContain('Revoke');
    expect(button('dialog-cancel').textContent).toContain('Cancel');
  });

  it('closes with true only on confirm', async () => {
    button('dialog-confirm').click();

    expect(await result).toBeTrue();
  });

  it('closes with false on cancel', async () => {
    button('dialog-cancel').click();

    expect(await result).toBeFalse();
  });
});
