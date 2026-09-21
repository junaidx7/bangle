import { describe, expect, test } from 'vitest';
import type { FilterableNote } from '../view';
import { compareViews, evaluateFilter, parseViewDefinition } from '../view';

const note = (over: Partial<FilterableNote> = {}): FilterableNote => ({
  title: 'A Note',
  type: 'Library',
  frontmatter: {},
  ...over,
});

describe('parseViewDefinition', () => {
  test('parses a real view file', () => {
    // Verbatim from views/pinned.yml in a real Tolaria vault.
    const view = parseViewDefinition({
      id: 'pinned',
      yaml: [
        'name: Pinned',
        'icon: push-pin',
        'color: gray',
        'order: 0',
        'sort: null',
        'filters:',
        '  all:',
        '  - field: Pinned',
        '    op: contains',
        '    value: Yes',
      ].join('\n'),
    });

    expect(view).toMatchObject({
      id: 'pinned',
      name: 'Pinned',
      icon: 'push-pin',
      color: 'gray',
      order: 0,
      sort: undefined,
    });
    expect(view?.filters).toEqual({
      combinator: 'all',
      // YAML 1.2 keeps `Yes` a string; the engine reconciles it with a
      // boolean `Pinned: true` when comparing.
      nodes: [{ field: 'Pinned', op: 'contains', value: 'Yes', regex: false }],
    });
  });

  test('a view without a name is rejected', () => {
    expect(parseViewDefinition({ id: 'x', yaml: 'icon: tag' })).toBeUndefined();
  });

  test('malformed YAML yields nothing rather than throwing', () => {
    expect(
      parseViewDefinition({ id: 'x', yaml: 'name: [unclosed' }),
    ).toBeUndefined();
  });

  test('an unparseable condition is dropped, keeping the view usable', () => {
    const view = parseViewDefinition({
      id: 'x',
      yaml: [
        'name: Mixed',
        'filters:',
        '  all:',
        '  - field: type',
        '    op: equals',
        '    value: Note',
        '  - field: type',
        '    op: not_a_real_op',
        '    value: Note',
      ].join('\n'),
    });
    expect(view?.filters?.nodes).toHaveLength(1);
  });

  test('orders views, sending unordered ones last', () => {
    const make = (name: string, order?: number) =>
      parseViewDefinition({
        id: name,
        yaml: `name: ${name}${order === undefined ? '' : `\norder: ${order}`}`,
      });
    const sorted = [make('Zed', 3), make('Loose'), make('Abe', 1)]
      .filter((v) => !!v)
      .sort(compareViews)
      .map((v) => v.name);
    expect(sorted).toEqual(['Abe', 'Zed', 'Loose']);
  });
});

describe('evaluateFilter', () => {
  const run = (yaml: string, target: FilterableNote) =>
    evaluateFilter(target, parseViewDefinition({ id: 'v', yaml })?.filters);

  test('matches a real project filter', () => {
    // views/job-hunting.yml
    const yaml = [
      'name: Job-Hunting',
      'filters:',
      '  all:',
      '  - field: Project',
      '    op: equals',
      '    value: Job-Hunting',
    ].join('\n');

    expect(run(yaml, note({ frontmatter: { Project: 'Job-Hunting' } }))).toBe(
      true,
    );
    expect(run(yaml, note({ frontmatter: { Project: 'islamic' } }))).toBe(
      false,
    );
  });

  test('frontmatter keys match regardless of capitalization', () => {
    // View files and notes are hand-written; "project" vs "Project" is drift,
    // not two distinct fields.
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: Project\n    op: equals\n    value: islamic';
    expect(run(yaml, note({ frontmatter: { project: 'Islamic' } }))).toBe(true);
  });

  test('matches any element of a list-valued property', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: tags\n    op: contains\n    value: ai';
    expect(run(yaml, note({ frontmatter: { tags: ['design', 'AI'] } }))).toBe(
      true,
    );
  });

  test('any: needs only one branch to hold', () => {
    const yaml = [
      'name: V',
      'filters:',
      '  any:',
      '  - field: type',
      '    op: equals',
      '    value: Prompt',
      '  - field: type',
      '    op: equals',
      '    value: Library',
    ].join('\n');
    expect(run(yaml, note({ type: 'Library' }))).toBe(true);
    expect(run(yaml, note({ type: 'Note' }))).toBe(false);
  });

  test.each([
    ['is_empty on a blank value', 'is_empty', { topic: '  ' }, true],
    ['is_empty on a missing key', 'is_empty', {}, true],
    ['is_empty on a real value', 'is_empty', { topic: 'x' }, false],
    ['is_not_empty on a real value', 'is_not_empty', { topic: 'x' }, true],
    ['is_not_empty on a null', 'is_not_empty', { topic: null }, false],
  ])('%s', (_label, op, frontmatter, expected) => {
    const yaml = `name: V\nfilters:\n  all:\n  - field: topic\n    op: ${op}`;
    expect(run(yaml, note({ frontmatter }))).toBe(expected);
  });

  test('negation holds when the field is absent entirely', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: status\n    op: not_equals\n    value: done';
    expect(run(yaml, note())).toBe(true);
  });

  test('any_of and none_of take a list', () => {
    const yaml = (op: string) =>
      `name: V\nfilters:\n  all:\n  - field: type\n    op: ${op}\n    value:\n    - Note\n    - Library`;
    expect(run(yaml('any_of'), note({ type: 'Library' }))).toBe(true);
    expect(run(yaml('none_of'), note({ type: 'Library' }))).toBe(false);
    expect(run(yaml('none_of'), note({ type: 'Prompt' }))).toBe(true);
  });

  test('regex matching is opt-in', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: title\n    op: contains\n    value: "^Weekly"\n    regex: true';
    expect(run(yaml, note({ title: 'Weekly Review' }))).toBe(true);
    expect(run(yaml, note({ title: 'My Weekly Review' }))).toBe(false);
  });

  test('an invalid regex matches nothing instead of throwing', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: title\n    op: contains\n    value: "([“"\n    regex: true';
    expect(() => run(yaml, note())).not.toThrow();
  });

  test('before and after compare dates', () => {
    const yaml = (op: string) =>
      `name: V\nfilters:\n  all:\n  - field: due\n    op: ${op}\n    value: 2026-06-01`;
    const target = note({ frontmatter: { due: '2026-03-01' } });
    expect(run(yaml('before'), target)).toBe(true);
    expect(run(yaml('after'), target)).toBe(false);
  });

  test('nested groups combine', () => {
    const yaml = [
      'name: V',
      'filters:',
      '  all:',
      '  - field: type',
      '    op: equals',
      '    value: Library',
      '  - any:',
      '    - field: Project',
      '      op: equals',
      '      value: a',
      '    - field: Project',
      '      op: equals',
      '      value: b',
    ].join('\n');
    expect(run(yaml, note({ frontmatter: { Project: 'b' } }))).toBe(true);
    expect(run(yaml, note({ frontmatter: { Project: 'c' } }))).toBe(false);
  });

  test('a view with no filters matches everything', () => {
    expect(run('name: All', note())).toBe(true);
  });

  test('wikilink relationship values match as written', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: related_to\n    op: contains\n    value: "[[tolaria]]"';
    expect(
      run(yaml, note({ frontmatter: { related_to: '[[tolaria]]' } })),
    ).toBe(true);
  });

  test('reconciles boolean spellings across notes and views', () => {
    // A note written `Pinned: true` and a view asking `value: Yes` are the
    // same intent expressed two ways; YAML alone would never match them.
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: Pinned\n    op: contains\n    value: Yes';
    expect(run(yaml, note({ frontmatter: { Pinned: true } }))).toBe(true);
    expect(run(yaml, note({ frontmatter: { Pinned: 'yes' } }))).toBe(true);
    expect(run(yaml, note({ frontmatter: { Pinned: false } }))).toBe(false);
    expect(run(yaml, note({ frontmatter: { Pinned: 'no' } }))).toBe(false);
  });

  test('ordinary text is never treated as boolean', () => {
    const yaml =
      'name: V\nfilters:\n  all:\n  - field: country\n    op: equals\n    value: NO';
    // "NO" here is a country code, not false — both sides look boolean, so
    // they canonicalize together and still match each other.
    expect(run(yaml, note({ frontmatter: { country: 'NO' } }))).toBe(true);
    expect(run(yaml, note({ frontmatter: { country: 'SE' } }))).toBe(false);
  });
});
