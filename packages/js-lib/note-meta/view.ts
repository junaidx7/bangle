import { parse as parseYaml } from 'yaml';
import type { Frontmatter } from './frontmatter';

export type FilterOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'any_of'
  | 'none_of'
  | 'is_empty'
  | 'is_not_empty'
  | 'before'
  | 'after';

const OPS = new Set<string>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'any_of',
  'none_of',
  'is_empty',
  'is_not_empty',
  'before',
  'after',
]);

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: unknown;
  /** Treat `value` as a regular expression, for the four text operators. */
  regex?: boolean;
}

export type FilterNode = FilterCondition | FilterGroup;

export interface FilterGroup {
  combinator: 'all' | 'any';
  nodes: FilterNode[];
}

export interface ViewDefinition {
  /** Filename without extension: the stable id, as Tolaria defines it. */
  id: string;
  name: string;
  icon: string | undefined;
  color: string | undefined;
  order: number;
  /** `option:direction`, e.g. `title:asc` or `property:onboarding:asc`. */
  sort: string | undefined;
  filters: FilterGroup | undefined;
}

/** The note fields a filter can address, beyond frontmatter keys. */
export interface FilterableNote {
  title: string;
  type: string | undefined;
  frontmatter: Frontmatter;
}

function isGroupShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNode(raw: unknown): FilterNode | undefined {
  if (!isGroupShape(raw)) {
    return undefined;
  }

  // A nested group: exactly one `all:` or `any:` key holding a list.
  for (const combinator of ['all', 'any'] as const) {
    const branch = raw[combinator];
    if (Array.isArray(branch)) {
      const nodes = branch
        .map((child) => parseNode(child))
        .filter((node) => !!node);
      return { combinator, nodes };
    }
  }

  const field = raw.field;
  const op = raw.op;
  if (typeof field !== 'string' || typeof op !== 'string' || !OPS.has(op)) {
    return undefined;
  }
  return {
    field,
    op: op as FilterOp,
    value: raw.value,
    regex: raw.regex === true,
  };
}

/**
 * Reads one `views/*.yml` file.
 *
 * Malformed YAML and unrecognized conditions yield a view with no filters
 * rather than an exception: a broken view file should show an empty list, not
 * take down the sidebar that lists every other view.
 */
export function parseViewDefinition({
  id,
  yaml,
}: {
  id: string;
  yaml: string;
}): ViewDefinition | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return undefined;
  }
  if (!isGroupShape(raw)) {
    return undefined;
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    // `name` is required; without it there is nothing to show in a sidebar.
    return undefined;
  }

  const order = Number(raw.order);
  const filters = parseNode(raw.filters);

  return {
    id,
    name,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    color: typeof raw.color === 'string' ? raw.color : undefined,
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
    sort: typeof raw.sort === 'string' ? raw.sort : undefined,
    filters:
      filters && 'combinator' in filters
        ? filters
        : filters
          ? { combinator: 'all', nodes: [filters] }
          : undefined,
  };
}

export function compareViews(a: ViewDefinition, b: ViewDefinition): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  return a.name.localeCompare(b.name);
}

/** Values a condition compares against, flattened from lists and scalars. */
function readFieldValues(note: FilterableNote, field: string): unknown[] {
  const key = field.toLowerCase();
  if (key === 'type') {
    return note.type === undefined ? [] : [note.type];
  }
  if (key === 'title') {
    return [note.title];
  }

  // Frontmatter keys are matched case-insensitively, because view files and
  // notes are hand-written and drift in capitalization ("Project" vs
  // "project") is far more likely than two keys differing only by case.
  for (const [name, value] of Object.entries(note.frontmatter)) {
    if (name.toLowerCase() === key) {
      return Array.isArray(value) ? value : [value];
    }
  }
  return [];
}

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function isEmptyValue(values: unknown[]): boolean {
  return values.every((value) => {
    const text = toText(value);
    return text === undefined || text.trim() === '';
  });
}

/**
 * Boolean spellings that YAML 1.2 leaves as plain strings but people write
 * interchangeably.
 *
 * Needed because notes and view files are authored by hand and by different
 * tools: a note may carry `Pinned: true` while a view asks for `value: Yes`.
 * Under YAML 1.2 those are a boolean and a string and would never match,
 * which is not what anyone writing them meant. Canonicalizing only when both
 * sides look boolean keeps ordinary text comparisons untouched, and avoids
 * YAML 1.1's habit of turning the country code NO into `false`.
 */
const TRUTHY = new Set(['true', 'yes', 'on']);
const FALSY = new Set(['false', 'no', 'off']);

function asBoolean(text: string): string | undefined {
  const normalized = text.trim().toLowerCase();
  if (TRUTHY.has(normalized)) {
    return 'true';
  }
  return FALSY.has(normalized) ? 'false' : undefined;
}

function matchesText(
  haystack: string,
  needle: string,
  { regex, exact }: { regex: boolean; exact: boolean },
): boolean {
  if (!regex) {
    const left = asBoolean(haystack);
    const right = asBoolean(needle);
    if (left !== undefined && right !== undefined) {
      return left === right;
    }
  }
  if (regex) {
    try {
      return new RegExp(needle, 'i').test(haystack);
    } catch {
      // An invalid pattern matches nothing rather than throwing mid-filter.
      return false;
    }
  }
  const a = haystack.toLowerCase();
  const b = needle.toLowerCase();
  return exact ? a === b : a.includes(b);
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function evaluateCondition(
  note: FilterableNote,
  condition: FilterCondition,
): boolean {
  const values = readFieldValues(note, condition.field);
  const regex = condition.regex === true;

  switch (condition.op) {
    case 'is_empty':
      return values.length === 0 || isEmptyValue(values);
    case 'is_not_empty':
      return values.length > 0 && !isEmptyValue(values);
    default:
      break;
  }

  const texts = values
    .map((value) => toText(value))
    .filter((text) => text !== undefined);

  switch (condition.op) {
    case 'equals':
    case 'contains': {
      const needle = toText(condition.value);
      if (needle === undefined) {
        return false;
      }
      const exact = condition.op === 'equals';
      return texts.some((text) => matchesText(text, needle, { regex, exact }));
    }
    case 'not_equals':
    case 'not_contains': {
      const needle = toText(condition.value);
      if (needle === undefined) {
        return true;
      }
      const exact = condition.op === 'not_equals';
      return !texts.some((text) => matchesText(text, needle, { regex, exact }));
    }
    case 'any_of':
    case 'none_of': {
      const needles = toList(condition.value)
        .map((value) => toText(value))
        .filter((text) => text !== undefined);
      const hit = needles.some((needle) =>
        texts.some((text) =>
          matchesText(text, needle, {
            regex: false,
            exact: true,
          }),
        ),
      );
      return condition.op === 'any_of' ? hit : !hit;
    }
    case 'before':
    case 'after': {
      const bound = Date.parse(toText(condition.value) ?? '');
      if (Number.isNaN(bound)) {
        return false;
      }
      return texts.some((text) => {
        const at = Date.parse(text);
        if (Number.isNaN(at)) {
          return false;
        }
        return condition.op === 'before' ? at < bound : at > bound;
      });
    }
    default:
      return false;
  }
}

export function evaluateFilter(
  note: FilterableNote,
  node: FilterNode | undefined,
): boolean {
  // A view with no filters matches everything, which is what an empty
  // `filters:` block reads as.
  if (!node) {
    return true;
  }
  if ('combinator' in node) {
    if (node.nodes.length === 0) {
      return true;
    }
    return node.combinator === 'all'
      ? node.nodes.every((child) => evaluateFilter(note, child))
      : node.nodes.some((child) => evaluateFilter(note, child));
  }
  return evaluateCondition(note, node);
}

/** Operators that take no `value`, so the builder hides the value field. */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set([
  'is_empty',
  'is_not_empty',
]);

/** Operators where a regular expression is meaningful. */
export const REGEX_OPS: ReadonlySet<FilterOp> = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
]);

function serializeNode(node: FilterNode, indent: string): string[] {
  if ('combinator' in node) {
    const lines = [`${indent}- ${node.combinator}:`];
    for (const child of node.nodes) {
      lines.push(...serializeNode(child, `${indent}  `));
    }
    return lines;
  }

  const lines = [
    `${indent}- field: ${quote(node.field)}`,
    `${indent}  op: ${node.op}`,
  ];
  if (!VALUELESS_OPS.has(node.op)) {
    lines.push(`${indent}  value: ${quote(String(node.value ?? ''))}`);
  }
  if (node.regex && REGEX_OPS.has(node.op)) {
    lines.push(`${indent}  regex: true`);
  }
  return lines;
}

/**
 * Quotes only when YAML would otherwise misread the text.
 *
 * Leaving simple words bare keeps generated files looking like the
 * hand-written ones already in a vault, which matters because people edit
 * these by hand after the builder creates them.
 */
function quote(value: string): string {
  if (value === '') {
    return "''";
  }
  if (
    /^[\w][\w .\-/]*$/.test(value) &&
    !/^(y|n|yes|no|on|off|true|false|null)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

export function serializeViewDefinition(view: {
  name: string;
  icon?: string | undefined;
  color?: string | undefined;
  order?: number | undefined;
  sort?: string | undefined;
  filters?: FilterGroup | undefined;
}): string {
  const lines = [
    `name: ${quote(view.name)}`,
    `icon: ${view.icon ? quote(view.icon) : 'null'}`,
    `color: ${view.color ? quote(view.color) : 'null'}`,
  ];
  if (view.order !== undefined) {
    lines.push(`order: ${view.order}`);
  }
  lines.push(`sort: ${view.sort ? quote(view.sort) : 'null'}`);

  if (view.filters && view.filters.nodes.length > 0) {
    lines.push('filters:');
    lines.push(`  ${view.filters.combinator}:`);
    for (const node of view.filters.nodes) {
      lines.push(...serializeNode(node, '  '));
    }
  }
  return `${lines.join('\n')}\n`;
}
