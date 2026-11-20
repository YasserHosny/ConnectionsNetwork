import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { initializeApp } from './app-initializer';
import { AuthService, SUPABASE_CLIENT } from './auth.service';
import { RuntimeConfig, type SupabaseConfig } from './runtime-config';

class FakeRuntimeConfig {
  supabase: SupabaseConfig | null = null;
  loaded = false;
  async load(): Promise<void> {
    await Promise.resolve();
    this.supabase = { url: 'http://127.0.0.1:54321', anonKey: 'anon-key' };
    this.loaded = true;
  }
}

describe('initializeApp', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideLocationMocks(),
        provideTranslateService(),
        { provide: RuntimeConfig, useClass: FakeRuntimeConfig },
      ],
    });
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  });

  it('loads the runtime config before the Supabase client is created', async () => {
    await TestBed.runInInjectionContext(() => initializeApp());

    expect(TestBed.inject(RuntimeConfig).supabase).not.toBeNull();
    expect(TestBed.inject(SUPABASE_CLIENT)).not.toBeNull();
  });

  describe('the contributor page and the sign-in session', () => {
    let clients: number;
    let init: jasmine.Spy;

    beforeEach(() => {
      clients = 0;
      init = spyOn(AuthService.prototype, 'init').and.resolveTo();
      TestBed.overrideProvider(SUPABASE_CLIENT, {
        useFactory: () => {
          clients++;
          return null;
        },
      });
    });

    for (const path of ['/c', '/c/', '/c?x=1']) {
      it(`does not start the sign-in session for ${path}`, async () => {
        TestBed.inject(Location).go(path);

        await TestBed.runInInjectionContext(() => initializeApp());

        expect(init).not.toHaveBeenCalled();
        expect(clients).toBe(0);
      });
    }

    for (const path of ['/', '/search', '/login', '/mfa', '/people/7', '/contact', '/c-not']) {
      it(`still restores the session for ${path}`, async () => {
        TestBed.inject(Location).go(path);

        await TestBed.runInInjectionContext(() => initializeApp());

        expect(init).toHaveBeenCalledTimes(1);
        expect(clients).toBe(1);
      });
    }
  });
});
