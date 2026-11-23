import { type SupportedLocale, arCatalog, enCatalog } from '@connections/i18n';

import { interpolate } from '../../core/interpolate';
import { whatsappShareUrl as shareUrl } from '../search/intro-message';

/** Why the link is sent: to add people (the links page), or with a stale profile (review). */
export type LinkPurpose = 'add' | 'update';

const MESSAGE: Record<LinkPurpose, Record<SupportedLocale, string>> = {
  add: { en: enCatalog.links.share.message, ar: arCatalog.links.share.message },
  update: { en: enCatalog.links.share.updateMessage, ar: arCatalog.links.share.updateMessage },
};

/**
 * The message the admin sends with a contributor link (spec 8.2). It carries the link itself, so
 * it is built when the link is shown and never kept. Wording comes from the catalogue of `locale`.
 *
 * The `update` message (a stale profile, spec 8.8) says what the link really does: it adds people.
 * A contributor link cannot edit a profile (spec 7.1), so it asks them to reply with any change to
 * their own details, which the admin then edits (ruling R21).
 */
export function buildLinkShareMessage(locale: SupportedLocale, url: string, purpose: LinkPurpose = 'add'): string {
  return interpolate(MESSAGE[purpose][locale], { url });
}

/**
 * `https://wa.me/?text=<message>`: WhatsApp opens with the text and no recipient, so the admin
 * chooses the chat there. No contact value is involved.
 */
export function whatsappShareUrl(text: string): string {
  return shareUrl(text);
}
