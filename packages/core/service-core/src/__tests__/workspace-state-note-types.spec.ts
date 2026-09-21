import { WORKSPACE_STORAGE_TYPE } from '@bangle.io/constants';
import { createTestEnvironment } from '@bangle.io/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNTYPED_NOTES_KEY } from '../workspace-state-service';

const WS = 'types-workspace';

/**
 * Note bodies below are shaped like a real Tolaria vault: kebab-case
 * filenames with the human title in the H1, type documents carrying display
 * metadata plus empty property templates, and a majority of notes with no
 * type at all.
 */
const NOTES: Record<string, string> = {
  'note.md': [
    '---',
    'type: Type',
    '_sidebar_label: Notes',
    '_icon: file-text',
    'color: yellow',
    '_order: 0',
    '---',
    '',
    '# Note',
  ].join('\n'),
  'library.md': [
    '---',
    'type: Type',
    'color: blue',
    '_icon: stack',
    '_sidebar_label: Library',
    'project: ',
    'topic: ',
    'what is it: ',
    '_order: 1',
    '---',
    '',
    '# Library',
  ].join('\n'),
  'hidden-type.md': [
    '---',
    'type: Type',
    'visible: false',
    '_order: 5',
    '---',
    '',
    '# Meta',
  ].join('\n'),
  'subject-to-learn.md': '---\ntype: Library\n---\n\n# Subject to Learn\n',
  'job-hunting.md': '---\ntype: Library\n---\n\n# Job Hunting\n',
  'youtube-video-ideas.md': '---\ntype: Note\n---\n\n# Youtube Video Ideas\n',
  'resume.md': '---\nproject: personal\n---\n\nno heading here\n',
  'plain.md': '# Just A Note\n',
};

describe('WorkspaceStateService note types', () => {
  let controller: AbortController | undefined;

  afterEach(() => {
    controller?.abort();
    vi.restoreAllMocks();
  });

  async function setup(notes: Record<string, string> = NOTES) {
    controller = new AbortController();
    const testEnv = createTestEnvironment({ controller });
    const services = testEnv.instantiateAll();
    await testEnv.mountAll();

    await services.workspaceOps.createWorkspaceInfo({
      name: WS,
      type: WORKSPACE_STORAGE_TYPE.Memory,
      metadata: {},
    });
    for (const [name, content] of Object.entries(notes)) {
      await services.fileSystem.createTextFile(`${WS}:${name}`, content);
    }

    services.navigation.goWorkspace(WS);
    const store = testEnv.store;
    await vi.waitFor(() => {
      expect(store.get(services.workspaceState.$noteWsPaths)).toHaveLength(
        Object.keys(notes).length,
      );
    });

    const index = services.workspaceState.$noteMetaIndex;
    const unsubscribe = store.sub(index, () => {});
    await vi.waitFor(
      () => {
        expect(store.get(index).status).toBe('ready');
      },
      { timeout: 5000 },
    );

    return { services, store, unsubscribe };
  }

  it('indexes every note with title and type', async () => {
    const { services, store, unsubscribe } = await setup();
    const index = store.get(services.workspaceState.$noteMetaIndex);

    expect(index.byWsPath.size).toBe(Object.keys(NOTES).length);
    expect(index.byWsPath.get(`${WS}:subject-to-learn.md`)).toMatchObject({
      title: 'Subject to Learn',
      type: 'Library',
    });
    unsubscribe();
  });

  it('falls back to the filename when a note has no H1', async () => {
    const { services, store, unsubscribe } = await setup();
    const index = store.get(services.workspaceState.$noteMetaIndex);
    // A real vault had 9 such notes; an empty title would render a blank row.
    expect(index.byWsPath.get(`${WS}:resume.md`)?.title).toBe('resume.md');
    unsubscribe();
  });

  it('discovers type documents in declared order', async () => {
    const { services, store, unsubscribe } = await setup();
    const types = store.get(services.workspaceState.$noteTypes);

    expect(types.map((t) => t.label)).toEqual(['Notes', 'Library']);
    expect(types[1]).toMatchObject({
      name: 'Library',
      icon: 'stack',
      color: 'blue',
    });
    unsubscribe();
  });

  it('keeps a type document out of its own type listing', async () => {
    const { services, store, unsubscribe } = await setup();
    const grouped = store.get(services.workspaceState.$notesByType);
    const untyped = grouped.get(UNTYPED_NOTES_KEY) ?? [];

    // library.md declares `type: Type`, so it describes the vault and is not
    // itself content — it must not appear anywhere as a note.
    expect(untyped.map((n) => n.wsPath)).not.toContain(`${WS}:library.md`);
    expect([...grouped.values()].flat().map((n) => n.wsPath)).not.toContain(
      `${WS}:note.md`,
    );
    unsubscribe();
  });

  it('exposes type property templates for authoring defaults', async () => {
    const { services, store, unsubscribe } = await setup();
    const library = store
      .get(services.workspaceState.$noteTypes)
      .find((t) => t.name === 'Library');

    expect(Object.keys(library?.properties ?? {}).sort()).toEqual([
      'project',
      'topic',
      'what is it',
    ]);
    unsubscribe();
  });

  it('hides a type marked visible:false but still indexes it', async () => {
    const { services, store, unsubscribe } = await setup();
    const visible = store.get(services.workspaceState.$noteTypes);
    const all = store.get(services.workspaceState.$noteMetaIndex).types;

    expect(visible.map((t) => t.name)).not.toContain('Meta');
    expect(all.map((t) => t.name)).toContain('Meta');
    unsubscribe();
  });

  it('groups notes by type and collects untyped ones', async () => {
    const { services, store, unsubscribe } = await setup();
    const grouped = store.get(services.workspaceState.$notesByType);

    expect(grouped.get('Library')?.map((n) => n.title)).toEqual([
      'Job Hunting',
      'Subject to Learn',
    ]);
    expect(grouped.get('Note')?.map((n) => n.title)).toEqual([
      'Youtube Video Ideas',
    ]);
    // Untyped notes must survive grouping, not vanish from the sidebar.
    expect(
      grouped
        .get(UNTYPED_NOTES_KEY)
        ?.map((n) => n.title)
        .sort(),
    ).toEqual(['Just A Note', 'resume.md']);
    unsubscribe();
  });

  it('a malformed note does not break the rest of the index', async () => {
    const { services, store, unsubscribe } = await setup({
      ...NOTES,
      'broken.md': '---\na: [unclosed\n---\n\n# Broken\n',
    });
    const index = store.get(services.workspaceState.$noteMetaIndex);

    expect(index.status).toBe('ready');
    expect(index.byWsPath.get(`${WS}:broken.md`)?.malformed).toBe(true);
    // Everything else still indexed normally.
    expect(index.byWsPath.get(`${WS}:subject-to-learn.md`)?.type).toBe(
      'Library',
    );
    unsubscribe();
  });
});
