/**
 * The note's display title: its first H1, falling back to the filename.
 *
 * Tolaria vaults name files in kebab-case and carry the human title in the
 * H1, so `walk-me-through-how-you-measured-that.md` is "walk me through how
 * you measured that". Reading the H1 is what makes a synced vault legible
 * instead of a list of slugs.
 */
export function extractTitle(
  body: string,
  fallback: string | undefined = undefined,
): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // ATX heading: `# Title`, requiring the space so `#tag` is not a title.
    const atx = /^#\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (atx?.[1]) {
      return atx[1].trim();
    }
    // Only the first non-blank content decides; a later H1 is a section.
    break;
  }
  return fallback;
}
