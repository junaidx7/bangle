import type { Frontmatter } from './frontmatter';

/** Frontmatter key holding a note's type, and the value marking a type doc. */
export const TYPE_FIELD = 'type';
export const TYPE_DOCUMENT_VALUE = 'Type';

/**
 * Keys a type document uses to describe itself rather than to seed instances.
 *
 * Everything else in a type document is a property template: an empty value
 * becomes a placeholder on new notes of that type, a filled one becomes a
 * default. Splitting the two is why `_order` does not end up copied onto
 * every note.
 */
const RESERVED_KEYS = new Set([
  TYPE_FIELD,
  'color',
  'visible',
  '_icon',
  '_sidebar_label',
  '_order',
  '_pinned',
  '_organized',
]);

export interface TypeDefinition {
  /** Type name as written in other notes' `type:` field, e.g. "Library". */
  name: string;
  /** The type document's own path, so the UI can open it. */
  wsPath: string;
  label: string;
  icon: string | undefined;
  color: string | undefined;
  order: number;
  visible: boolean;
  /**
   * Property template for new notes of this type. Empty values are
   * placeholders; non-empty ones are defaults.
   */
  properties: Frontmatter;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isTypeDocument(frontmatter: Frontmatter): boolean {
  return readString(frontmatter[TYPE_FIELD]) === TYPE_DOCUMENT_VALUE;
}

/** The type a note declares, or undefined when it is untyped. */
export function readNoteType(frontmatter: Frontmatter): string | undefined {
  const value = readString(frontmatter[TYPE_FIELD]);
  return value === TYPE_DOCUMENT_VALUE ? undefined : value;
}

export function parseTypeDocument({
  wsPath,
  title,
  frontmatter,
}: {
  wsPath: string;
  title: string | undefined;
  frontmatter: Frontmatter;
}): TypeDefinition | undefined {
  if (!isTypeDocument(frontmatter)) {
    return undefined;
  }

  // The H1 is the type's name, because that is what other notes write in
  // their `type:` field — `# Library` is referenced as `type: Library`.
  const name = title?.trim();
  if (!name) {
    return undefined;
  }

  const order = Number(frontmatter._order);
  const properties: Frontmatter = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!RESERVED_KEYS.has(key)) {
      properties[key] = value;
    }
  }

  return {
    name,
    wsPath,
    label: readString(frontmatter._sidebar_label) ?? name,
    icon: readString(frontmatter._icon),
    color: readString(frontmatter.color),
    // Unordered types sort after ordered ones rather than jumping to the top.
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
    // Only an explicit `visible: false` hides a type; absent means visible.
    visible: frontmatter.visible !== false,
    properties,
  };
}

/** Sorts by `_order`, then label, so the sidebar is stable and predictable. */
export function compareTypes(a: TypeDefinition, b: TypeDefinition): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  return a.label.localeCompare(b.label);
}
