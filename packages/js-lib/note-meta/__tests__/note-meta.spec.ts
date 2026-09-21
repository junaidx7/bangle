import { describe, expect, test } from 'vitest';
import { parseFrontmatter, splitFrontmatter } from '../frontmatter';
import {
  compareTypes,
  isTypeDocument,
  parseTypeDocument,
  readNoteType,
} from '../note-type';
import { extractTitle } from '../title';

describe('splitFrontmatter', () => {
  test('splits a normal block', () => {
    const result = splitFrontmatter('---\ntype: Note\n---\n\n# Hello\n\nbody');
    expect(result.raw).toBe('type: Note');
    expect(result.body).toBe('\n# Hello\n\nbody');
  });

  test('accepts the YAML document-end marker as a close', () => {
    expect(splitFrontmatter('---\na: 1\n...\nbody').raw).toBe('a: 1');
  });

  test.each([
    ['no frontmatter', '# Just a note'],
    ['fence not on line 0', '\n---\na: 1\n---'],
    ['unterminated block', '---\na: 1\n\nstill going'],
    ['more than three dashes', '----\na: 1\n----'],
  ])('declines: %s', (_label, input) => {
    const result = splitFrontmatter(input);
    expect(result.raw).toBeUndefined();
    expect(result.body).toBe(input);
  });

  test('an indented fence does not close the block', () => {
    // Matches the tokenizer: indented dashes are ordinary Markdown.
    const result = splitFrontmatter('---\na: 1\n  ---\nb: 2\n---\nbody');
    expect(result.raw).toBe('a: 1\n  ---\nb: 2');
  });
});

describe('parseFrontmatter', () => {
  test('parses the key styles a real vault uses', () => {
    // Taken from library.md: mixed underscore-prefixed and plain keys,
    // spaces in key names, and deliberately empty values.
    const { frontmatter } = parseFrontmatter(
      [
        '---',
        'type: Type',
        'color: blue',
        '_icon: stack',
        '_sidebar_label: Library',
        '_pinned:',
        'project: ',
        'topic: ',
        'what is it: ',
        '_order: 1',
        'Pinned: true',
        '---',
        '',
        '# Library',
      ].join('\n'),
    );

    expect(frontmatter._sidebar_label).toBe('Library');
    expect(frontmatter['what is it']).toBeNull();
    expect(frontmatter._order).toBe(1);
    expect(frontmatter.Pinned).toBe(true);
  });

  test('reports malformed YAML without throwing', () => {
    const result = parseFrontmatter('---\na: [unclosed\n---\n# Note');
    expect(result.malformed).toBe(true);
    expect(result.frontmatter).toEqual({});
    // The note is still usable even though its properties are not.
    expect(result.body).toBe('# Note');
  });

  test('an empty block is not malformed, just empty', () => {
    const result = parseFrontmatter('---\n---\n# Note');
    expect(result).toMatchObject({ malformed: false, frontmatter: {} });
  });

  test('a non-map block yields no properties', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\n# N').frontmatter).toEqual({});
  });

  test('wikilink values survive as written', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nproject: "[[some project]]"\n---\n# N',
    );
    expect(frontmatter.project).toBe('[[some project]]');
  });
});

describe('extractTitle', () => {
  test('reads the first H1', () => {
    expect(extractTitle('\n# Subject to Learn\n\nbody')).toBe(
      'Subject to Learn',
    );
  });

  test('ignores a later heading when the note does not start with one', () => {
    expect(extractTitle('intro text\n\n# Not the title')).toBeUndefined();
  });

  test('requires a space, so a tag is not a title', () => {
    expect(extractTitle('#tag line')).toBeUndefined();
  });

  test('strips closing hashes', () => {
    expect(extractTitle('# Title #')).toBe('Title');
  });

  test('falls back when there is no heading', () => {
    expect(extractTitle('plain body', 'resume')).toBe('resume');
  });
});

describe('type documents', () => {
  const libraryFrontmatter = {
    type: 'Type',
    color: 'blue',
    _icon: 'stack',
    _sidebar_label: 'Library',
    _order: 1,
    project: null,
    topic: null,
    'what is it': null,
  };

  test('parses a real type document', () => {
    const def = parseTypeDocument({
      wsPath: 'ws:library.md',
      title: 'Library',
      frontmatter: libraryFrontmatter,
    });

    expect(def).toMatchObject({
      name: 'Library',
      label: 'Library',
      icon: 'stack',
      color: 'blue',
      order: 1,
      visible: true,
    });
  });

  test('keeps only template properties, not display metadata', () => {
    const def = parseTypeDocument({
      wsPath: 'ws:library.md',
      title: 'Library',
      frontmatter: libraryFrontmatter,
    });
    // _order and _icon describe the type; project/topic seed its notes.
    expect(Object.keys(def?.properties ?? {}).sort()).toEqual([
      'project',
      'topic',
      'what is it',
    ]);
  });

  test('falls back to the name when no sidebar label is set', () => {
    const def = parseTypeDocument({
      wsPath: 'ws:note.md',
      title: 'Note',
      frontmatter: { type: 'Type' },
    });
    expect(def?.label).toBe('Note');
  });

  test('only an explicit visible:false hides a type', () => {
    const hidden = parseTypeDocument({
      wsPath: 'ws:type.md',
      title: 'Type',
      frontmatter: { type: 'Type', visible: false },
    });
    expect(hidden?.visible).toBe(false);
  });

  test('a note that is not a type document yields nothing', () => {
    expect(
      parseTypeDocument({
        wsPath: 'ws:a.md',
        title: 'A',
        frontmatter: { type: 'Library' },
      }),
    ).toBeUndefined();
  });

  test('a type document with no H1 is skipped, since it has no name', () => {
    expect(
      parseTypeDocument({
        wsPath: 'ws:a.md',
        title: undefined,
        frontmatter: { type: 'Type' },
      }),
    ).toBeUndefined();
  });

  test('isTypeDocument and readNoteType do not confuse each other', () => {
    expect(isTypeDocument({ type: 'Type' })).toBe(true);
    expect(readNoteType({ type: 'Type' })).toBeUndefined();
    expect(readNoteType({ type: 'Library' })).toBe('Library');
    expect(readNoteType({})).toBeUndefined();
  });

  test('unordered types sort after ordered ones', () => {
    const make = (name: string, order?: number) =>
      parseTypeDocument({
        wsPath: `ws:${name}.md`,
        title: name,
        frontmatter: {
          type: 'Type',
          ...(order === undefined ? {} : { _order: order }),
        },
      });

    const sorted = [make('Zeta', 2), make('Unordered'), make('Alpha', 0)]
      .filter((d) => !!d)
      .sort(compareTypes)
      .map((d) => d.name);

    expect(sorted).toEqual(['Alpha', 'Zeta', 'Unordered']);
  });
});
