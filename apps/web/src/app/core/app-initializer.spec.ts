import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { initializeApp } from './app-initializer';
import { SUPABASE_CLIENT } from './auth.service';
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
      providers: [provideTranslateService(), { provide: RuntimeConfig, useClass: FakeRuntimeConfig }],
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
});
