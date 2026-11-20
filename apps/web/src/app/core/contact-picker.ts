/** What the Contact Picker API returns for one contact: every property is a list of strings. */
interface PickedEntry {
  name?: string[];
  tel?: string[];
  email?: string[];
}

interface ContactsManager {
  select(properties: string[], options?: { multiple?: boolean }): Promise<PickedEntry[]>;
}

export interface PickedContact {
  name?: string;
  tel?: string;
  email?: string;
}

function contactsManager(): ContactsManager | null {
  const manager = (navigator as Navigator & { contacts?: Partial<ContactsManager> }).contacts;
  return typeof manager?.select === 'function' ? (manager as ContactsManager) : null;
}

/** The Contact Picker API exists on Android Chrome (secure context); elsewhere hide the button. */
export function isContactPickerSupported(): boolean {
  return contactsManager() !== null;
}

const first = (values: string[] | undefined): string | undefined => values?.[0]?.trim() || undefined;

/**
 * Asks the person to pick one contact and returns its name, first phone and first email. It
 * resolves null when the API is missing, nothing was picked, or the picker was dismissed or failed.
 */
export async function pickContact(): Promise<PickedContact | null> {
  const manager = contactsManager();
  if (!manager) return null;
  try {
    const [entry] = await manager.select(['name', 'tel', 'email'], { multiple: false });
    if (!entry) return null;
    const picked: PickedContact = {};
    const name = first(entry.name);
    const tel = first(entry.tel);
    const email = first(entry.email);
    if (name) picked.name = name;
    if (tel) picked.tel = tel;
    if (email) picked.email = email;
    return Object.keys(picked).length ? picked : null;
  } catch {
    return null;
  }
}
