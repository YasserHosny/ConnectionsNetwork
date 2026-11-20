/** A digit as people type it here: Latin, Arabic-Indic or Extended Arabic-Indic. */
const DIGIT = '[0-9٠-٩۰-۹]';

/** Seven or more digits in a row, with spaces, +, brackets, dots, dashes or slashes between them. */
const DIGIT_RUN = new RegExp(`${DIGIT}(?:[\\s+()./-]*${DIGIT}){6,}`);

/** Something@something: an email address, or text that is one. A bare `@handle` is not. */
const EMAIL_TOKEN = /[^\s@]+@[^\s@]+/;

/**
 * True when `text` contains what looks like a contact value: an email address, or a run of seven
 * or more digits (a phone number written any way, "Sara 01012345678" included).
 *
 * Contact values must never reach a URL our app serves (global constraints: URLs end up in proxy
 * and server logs), so text that contains one is not put in a query string. Seven digits keep
 * years, ages and short codes searchable.
 */
export function containsContactValue(text: string): boolean {
  return EMAIL_TOKEN.test(text) || DIGIT_RUN.test(text);
}
