import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';

import { LocaleService } from '../core/locale.service';

/** Switches between Arabic and English; the button names the language it switches to. */
@Component({
  selector: 'app-language-switch',
  imports: [MatButtonModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      mat-button
      type="button"
      [attr.aria-label]="(target() === 'en' ? 'common.language.switchToEn' : 'common.language.switchToAr') | translate"
      (click)="switchLanguage()"
    >
      <span [attr.lang]="target()">{{ 'common.language.' + target() | translate }}</span>
    </button>
  `,
})
export class LanguageSwitchComponent {
  private readonly locale = inject(LocaleService);

  protected readonly target = computed(() => (this.locale.locale() === 'ar' ? 'en' : 'ar'));

  protected switchLanguage(): void {
    this.locale.setLocale(this.target());
  }
}
