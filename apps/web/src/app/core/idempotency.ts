/** What the API accepts as an `Idempotency-Key` (a UUID fits). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A fresh key for one submission (spec 11.1). The form sends it with the create request and with
 * every retry of that same submission, so a retry whose first attempt did reach the server gets
 * the same person back instead of a second one.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
