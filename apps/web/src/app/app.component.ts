import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AppUpdates } from './core/app-updates';
import { UpdateBannerComponent } from './layout/update-banner.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UpdateBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The update banner waits for idle time: it is never needed for the first paint, and deferring it
  // keeps Material's button out of the initial bundle.
  template: '<router-outlet /> @defer (on idle) { <app-update-banner /> }',
})
export class AppComponent {
  // Listening from startup: the "new version ready" event is not replayed for the deferred banner.
  private readonly updates = inject(AppUpdates);
}
