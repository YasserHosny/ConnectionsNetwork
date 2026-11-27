import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Whether a new version of the app has been downloaded and is waiting for a reload.
 *
 * Created at startup (AppComponent injects it): the service worker reports VERSION_READY once,
 * through a stream that does not replay, and the banner that shows it loads later, when the browser
 * is idle. Nothing is reported without a service worker (development).
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly updates = inject(SwUpdate);

  readonly ready = signal(false);

  constructor() {
    if (!this.updates.isEnabled) return;
    this.updates.versionUpdates
      .pipe(filter((event) => event.type === 'VERSION_READY'))
      .subscribe(() => this.ready.set(true));
  }

  /** Not now: the next load picks up the new version anyway. */
  dismiss(): void {
    this.ready.set(false);
  }
}
