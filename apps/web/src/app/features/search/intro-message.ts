import type { ContactKind, PathNode } from '@connections/domain-types';
import { type SupportedLocale, arCatalog, enCatalog } from '@connections/i18n';

const INTRO = { en: enCatalog.search.intro, ar: arCatalog.search.intro } as const;

/** Country code assumed for a number written the local way (global constraints: +20, Egypt). */
const DEFAULT_COUNTRY_CODE = '20';

/** Fills `{{name}}` placeholders in one pass, so a value that contains `{{x}}` stays as typed. */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * The message that asks the first person on a path for an introduction (spec 8.6). `path` runs
 * from the owner (index 0, not named) to the target (last). It is addressed to `path[1]` and
 * names the target; with more than three people on the path it also says who, just before the
 * target, knows them. Wording comes from the catalogue of `locale`, whatever language the app is in.
 *
 * Returns '' when no message applies: a direct contact (two people) has nobody to ask.
 */
export function buildIntroMessage(
  locale: SupportedLocale,
  path: readonly Pick<PathNode, 'display_name'>[],
): string {
  if (path.length < 3) return '';
  const texts = INTRO[locale];
  const firstHop = path[1].display_name;
  const target = path[path.length - 1].display_name;

  const lines = [interpolate(texts.ask, { firstHop, target })];
  if (path.length > 3) {
    lines.push(interpolate(texts.knows, { knower: path[path.length - 2].display_name, target }));
  }
  return lines.join(' ');
}

/** Digits of a phone number: Latin or Arabic-Indic, everything else (spaces, +, -, brackets) dropped. */
function digitsOf(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

/**
 * `https://wa.me/<digits>?text=<encoded text>`. wa.me wants the number with its country code, so
 * a `00` prefix is dropped and a number written the local way (`010…`) gets +20.
 *
 * This opens WhatsApp, an external app; it is not a URL this app serves, so the rule that contact
 * values stay out of our own URLs holds.
 */
export function whatsappUrl(phone: string, text: string): string {
  let digits = digitsOf(phone);
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
  const base = `https://wa.me/${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** The number to open WhatsApp on: a whatsapp value first, else a phone, else none. */
export function pickWhatsappNumber(
  contacts: readonly { kind: ContactKind; value: string }[],
): string | null {
  const of = (kind: ContactKind) => contacts.find((c) => c.kind === kind)?.value;
  return of('whatsapp') ?? of('phone') ?? null;
}
