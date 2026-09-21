import { parse as parseYaml } from 'yaml';

/**
 * Only an unindented `---` on the very first line opens frontmatter, and
 * either `---` or YAML's document-end `...` closes it.
 *
 * These rules are copied from the editor's tokenizer
 * (`frontmatterTokenizer` in `@bangle.io/markdown-syntax`) on purpose. If the
 * index and the editor disagreed about what counts as frontmatter, a note
 * would show properties the editor does not treat as properties, or the
 * reverse — so the two must decline in exactly the same cases.
 */
const OPENING_FENCE = '---';
const CLOSING_FENCES = new Set(['---', '...']);

export interface SplitNote {
  /** Raw YAML between the fences, or undefined when there is no frontmatter. */
  raw: string | undefined;
  /** Everything after the closing fence; the whole note when there is none. */
  body: string;
}

export function splitFrontmatter(markdown: string): SplitNote {
  const lines = markdown.split('\n');
  if (lines[0]?.trimEnd() !== OPENING_FENCE) {
    return { raw: undefined, body: markdown };
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    // An indented fence is ordinary Markdown, matching the tokenizer.
    if (line.startsWith(' ') || line.startsWith('\t')) {
      continue;
    }
    if (CLOSING_FENCES.has(line.trimEnd())) {
      return {
        raw: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }

  // Unterminated: not frontmatter at all, exactly as the tokenizer decides.
  return { raw: undefined, body: markdown };
}

export type FrontmatterValue = unknown;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
  /**
   * True when a frontmatter block was present but its YAML did not parse.
   *
   * Surfaced rather than thrown: one malformed note must not break an index
   * covering every note in the workspace, and the note still has a title and
   * body worth showing.
   */
  malformed: boolean;
}

export function parseFrontmatter(markdown: string): ParsedNote {
  const { raw, body } = splitFrontmatter(markdown);
  if (raw === undefined) {
    return { frontmatter: {}, body, malformed: false };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return { frontmatter: {}, body, malformed: true };
  }

  // An empty block parses to null, and a bare scalar or list is valid YAML but
  // not a property map — neither is malformed, there are simply no properties.
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body, malformed: false };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, body, malformed: false };
  }

  return { frontmatter: parsed as Frontmatter, body, malformed: false };
}
