import { type SupportedLocale, arCatalog, enCatalog } from '@connections/i18n';

import { interpolate } from '../../core/interpolate';
import { whatsappUrl } from '../search/intro-message';

const MESSAGE = { en: enCatalog.links.share.message, ar: arCatalog.links.share.message } as const;

/**
 * The message the admin sends with a contributor link (spec 8.2). It carries the link itself, so
 * it is built when the link is shown and never kept. Wording comes from the catalogue of `locale`.
 */
export function buildLinkShareMessage(locale: SupportedLocale, url: string): string {
  return interpolate(MESSAGE[locale], { url });
}

/**
 * `https://wa.me/?text=<message>`: WhatsApp opens with the text and no recipient, so the admin
 * chooses the chat there. No contact value is involved.
 */
export function whatsappShareUrl(text: string): string {
  return whatsappUrl('', text);
}
