import { Injectable } from '@angular/core';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Deployment settings that must not be baked into the build: the Supabase project URL and its
 * public (anon) key. They are read once at startup from `runtime-config.json`, which is served
 * next to the app and never cached by the service worker (ngsw-config.json lists it nowhere).
 * The deploy step overwrites that file; the committed copy is a local-development placeholder.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeConfig {
  private supabaseConfig: SupabaseConfig | null = null;

  /** Null until `load()` has run, or when the file is missing or incomplete. */
  get supabase(): SupabaseConfig | null {
    return this.supabaseConfig;
  }

  async load(): Promise<void> {
    try {
      const response = await fetch('runtime-config.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.supabaseConfig = parseSupabaseConfig(await response.json());
    } catch (error) {
      // The app still starts: sign-in then reports "not configured" instead of a blank page.
      console.error('[config] runtime-config.json could not be read', error);
      this.supabaseConfig = null;
    }
  }
}

export function parseSupabaseConfig(raw: unknown): SupabaseConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { supabaseUrl, supabaseAnonKey } = raw as Record<string, unknown>;
  if (typeof supabaseUrl !== 'string' || typeof supabaseAnonKey !== 'string') return null;
  if (!supabaseUrl.trim() || !supabaseAnonKey.trim()) return null;
  return { url: supabaseUrl.trim(), anonKey: supabaseAnonKey.trim() };
}
