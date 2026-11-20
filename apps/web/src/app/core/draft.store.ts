import { Injectable } from '@angular/core';

const PREFIX = 'connections.draft.';

/**
 * Unsent form data kept on this device, so a failed quick add (online-only app) is not lost.
 *
 * Keys name the form ("add-person", "edit-person:<id>"). Drafts hold whatever was typed, contact
 * values included, in localStorage on this device only (spec 4); they never go into a URL.
 * Storage can throw (private mode, quota, blocked site data), so every call is wrapped: a draft
 * that cannot be kept is simply not kept.
 */
@Injectable({ providedIn: 'root' })
export class DraftStore {
  save(key: string, value: unknown): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Not kept; see the class comment.
    }
  }

  /** The saved draft, or null when there is none, it is unreadable, or storage is unavailable. */
  load<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  clear(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // Nothing to remove, or it cannot be removed.
    }
  }

  /** Every draft on this device, whatever form it belongs to (sign-out: they hold contact values). */
  clearAll(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch {
      // Storage is unavailable: there is nothing it could still hold for us.
    }
  }
}
