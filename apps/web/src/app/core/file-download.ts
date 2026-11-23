/** How long the object URL stays valid after the click, so the browser has started the download. */
const REVOKE_DELAY_MS = 1000;

/**
 * Saves `blob` as `filename` through the browser's download: an object URL on a temporary link,
 * clicked, then revoked so the file does not stay in memory.
 */
export function saveBlob(doc: Document, blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
