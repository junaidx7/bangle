/**
 * Binary-safe base64 helpers. GitHub's blob API only speaks base64, and notes
 * routinely carry non-ASCII (em dashes, emoji), so going through `btoa` on a
 * raw JS string would corrupt them. We convert via bytes in both directions.
 */

const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit
  // on files of any real size.
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  // GitHub pretty-prints blob payloads with newlines; atob rejects them.
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
