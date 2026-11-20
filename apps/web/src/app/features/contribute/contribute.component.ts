import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { LanguageSwitchComponent } from '../../layout/language-switch.component';

/** The public contributor page (/c#token). Placeholder: the form arrives with Task 16. */
@Component({
  selector: 'app-contribute',
  imports: [TranslatePipe, LanguageSwitchComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <app-language-switch />
      <h1>{{ 'contribute.title' | translate }}</h1>
      <p>{{ 'common.comingSoon' | translate }}</p>
    </main>
  `,
  styles: `
    .page {
      max-inline-size: 640px;
      margin-inline: auto;
      padding: 16px;
    }
  `,
})
export class ContributeComponent {}
