import type { ContactKind } from '@connections/domain-types';

import { whatsappUrl } from '../search/intro-message';

/**
 * Where a contact value opens: the phone app, WhatsApp or the mail app. These hand the value to an
 * external app; none is a URL this app serves, so contact values stay out of our own URLs.
 */
export function contactHref(kind: ContactKind, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  switch (kind) {
    case 'phone':
      return `tel:${trimmed.replace(/[^\d+]/g, '')}`;
    case 'whatsapp':
      return whatsappUrl(trimmed, '');
    case 'email':
      return `mailto:${trimmed}`;
  }
}
