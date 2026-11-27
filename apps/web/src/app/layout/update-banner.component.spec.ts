import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';

import { AppUpdates } from '../core/app-updates';
import { LocaleService } from '../core/locale.service';
import { loadCatalogues } from '../testing/test-helpers';
import { RELOAD_PAGE, UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent', () => {
  let events: Subject<VersionEvent>;
  let activateUpdate: jasmine.Spy;
  let reload: jasmine.Spy;

  const ready = { type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } } as VersionEvent;

  function configure(enabled = true): void {
    events = new Subject<VersionEvent>();
    // A worker in safe mode never answers activation: Reload must not wait for it.
    activateUpdate = jasmine.createSpy('activateUpdate').and.returnValue(new Promise(() => undefined));
    reload = jasmine.createSpy('reload');
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: SwUpdate, useValue: { isEnabled: enabled, versionUpdates: events.asObservable(), activateUpdate } },
        { provide: RELOAD_PAGE, useValue: reload },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    TestBed.inject(AppUpdates); // what AppComponent does at startup
  }

  function render() {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  afterEach(() => document.body.classList.remove('update-banner-open'));

  it('stays out of the way until a new version has been downloaded', () => {
    configure();
    const { fixture, el } = render();
    events.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } } as VersionEvent);
    fixture.detectChanges();

    expect(el.querySelector('.update-banner')).toBeNull();
  });

  it('offers to reload once a new version is ready, and reloads only when asked, without waiting on the worker', () => {
    configure();
    const { fixture, el } = render();
    events.next(ready);
    fixture.detectChanges();

    const banner = el.querySelector('.update-banner') as HTMLElement;
    expect(banner.textContent).toContain('A new version is ready');
    expect(reload).not.toHaveBeenCalled();

    (banner.querySelector('button.reload') as HTMLButtonElement).click();

    expect(reload).toHaveBeenCalled();
  });

  // The banner loads when the browser is idle; the download can finish before that.
  it('shows a version that became ready before the banner loaded', () => {
    configure();
    events.next(ready);

    const { el } = render();

    expect(el.querySelector('.update-banner')).not.toBeNull();
  });

  it('announces it through a status region that was there, empty, before the message', fakeAsync(() => {
    configure();
    const { fixture, el } = render();
    const region = el.querySelector('[role=status]') as HTMLElement;
    expect(region.textContent?.trim()).toBe('');

    events.next(ready);
    fixture.detectChanges();
    tick(500);
    fixture.detectChanges();

    expect(el.querySelector('[role=status]')).toBe(region);
    expect(region.textContent).toContain('A new version is ready');
    expect(region.querySelector('button')).toBeNull();
  }));

  it('makes room at the bottom of the page while it shows, and gives it back', () => {
    configure();
    const { fixture, el } = render();
    events.next(ready);
    fixture.detectChanges();
    expect(document.body.classList).toContain('update-banner-open');

    (el.querySelector('.update-banner button.later') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(el.querySelector('.update-banner')).toBeNull();
    expect(document.body.classList).not.toContain('update-banner-open');
    expect(reload).not.toHaveBeenCalled();
  });

  it('never shows without a service worker (development)', () => {
    configure(false);
    const { el } = render();

    expect(el.querySelector('.update-banner')).toBeNull();
  });
});
