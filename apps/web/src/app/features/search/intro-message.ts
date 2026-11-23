import type { ContactKind, PathNode } from '@connections/domain-types';
import { type SupportedLocale, arCatalog, enCatalog } from '@connections/i18n';

import { isolate } from '../../core/bidi';
import { interpolate } from '../../core/interpolate';

const INTRO = { en: enCatalog.search.intro, ar: arCatalog.search.intro } as const;

/** Country code assumed for a number written the local way (global constraints: +20, Egypt). */
const DEFAULT_COUNTRY_CODE = '20';
/** Fewer digits than this (country code included) is not a number WhatsApp can be sure of. */
const MIN_INTERNATIONAL_DIGITS = 10;
const MAX_INTERNATIONAL_DIGITS = 15;

/**
 * The message that asks the first person on a path for an introduction (spec 8.6). `path` runs
 * from the owner (index 0, not named) to the target (last). It is addressed to `path[1]`:
 *   * three people (you, them, the target): they know the target, so ask them directly;
 *   * four or more: ask whether they know someone who can introduce you, and say who, just before
 *     the target, knows them.
 * Names are isolated (core/bidi) so each keeps its own direction in the other script's sentence.
 * Wording comes from the catalogue of `locale`, whatever language the app is in.
 *
 * Returns '' when no message applies: a direct contact (two people) has nobody to ask.
 */
export function buildIntroMessage(
  locale: SupportedLocale,
  path: readonly Pick<PathNode, 'display_name'>[],
): string {
  if (path.length < 3) return '';
  const texts = INTRO[locale];
  const firstHop = isolate(path[1].display_name);
  const target = isolate(path[path.length - 1].display_name);

  if (path.length === 3) return interpolate(texts.askDirect, { firstHop, target });
  const knower = isolate(path[path.length - 2].display_name);
  return [interpolate(texts.ask, { firstHop, target }), interpolate(texts.knows, { knower, target })].join(' ');
}

/** Latin digits for Arabic-Indic and Extended Arabic-Indic ones; everything else as typed. */
function asciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

interface PhoneParts {
  digits: string;
  hasPlus: boolean;
}

function phoneParts(value: string): PhoneParts {
  // "+44 (0)7911 …": the (0) is the national trunk prefix, not dialled after a country code.
  const text = asciiDigits(value).replace(/(\d[\s.-]*)\(\s*0\s*\)/, '$1');
  return { digits: text.replace(/\D/g, ''), hasPlus: /^[^0-9+]*\+/.test(text) };
}

/**
 * The number with its country code, digits only, by the API's normalize_phone rules (rulings R7,
 * R8): a leading + or 00 carries the country code; a leading 0 is the national prefix of +20;
 * `20` and ten digits is an Egyptian number written with its code; ten digits starting with 1 is an
 * Egyptian mobile without its 0. Anything else, or a result too short or too long for an
 * international number, cannot be placed: null, rather than a guess that could reach a stranger.
 */
function internationalDigits(value: string): string | null {
  const { digits, hasPlus } = phoneParts(value);
  if (/^0*$/.test(digits)) return null;
  let placed: string;
  if (hasPlus) placed = digits;
  else if (digits.startsWith('00')) placed = digits.slice(2);
  else if (digits.startsWith('0')) placed = DEFAULT_COUNTRY_CODE + digits.slice(1);
  else if (/^20\d{10}$/.test(digits)) placed = digits;
  else if (/^1\d{9}$/.test(digits)) placed = DEFAULT_COUNTRY_CODE + digits;
  else return null;
  return placed.length >= MIN_INTERNATIONAL_DIGITS && placed.length <= MAX_INTERNATIONAL_DIGITS
    ? placed
    : null;
}

/**
 * What a `tel:` link dials: `+<country><number>` when the number can be placed (the same rules as
 * WhatsApp), else the digits as typed (a short local number), Arabic-Indic digits converted.
 * Null when there are no digits at all.
 */
export function phoneDigits(value: string): string | null {
  const placed = internationalDigits(value);
  if (placed) return `+${placed}`;
  const { digits, hasPlus } = phoneParts(value);
  return digits ? `${hasPlus ? '+' : ''}${digits}` : null;
}

/**
 * `https://wa.me/<digits>?text=<encoded text>`, or null when the number cannot be placed in a
 * country (`internationalDigits`): the caller then offers the text to copy instead.
 *
 * This opens WhatsApp, an external app; it is not a URL this app serves, so the rule that contact
 * values stay out of our own URLs holds.
 */
export function whatsappUrl(phone: string, text: string): string | null {
  const digits = internationalDigits(phone);
  if (!digits) return null;
  const base = `https://wa.me/${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** `https://wa.me/?text=<encoded text>`: WhatsApp opens with the text and no recipient. */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** The number to open WhatsApp on: a whatsapp value first, else a phone, else none. */
export function pickWhatsappNumber(
  contacts: readonly { kind: ContactKind; value: string }[],
): string | null {
  const of = (kind: ContactKind) => contacts.find((c) => c.kind === kind)?.value;
  return of('whatsapp') ?? of('phone') ?? null;
}
