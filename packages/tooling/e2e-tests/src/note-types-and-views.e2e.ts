import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  createBrowserWorkspace,
  writeStoredFile,
  writeStoredMarkdown,
} from './common';

function notesTable(page: Page): Locator {
  return page.getByTestId('ws-home-notes-table');
}

/** The table lists notes by file name, which is what a row is addressed by. */
function noteRow(page: Page, fileName: string): Locator {
  return notesTable(page).locator('tbody tr', { hasText: fileName });
}

/**
 * Notes are seeded straight into storage rather than typed through the
 * editor, because what is under test is the index reading frontmatter that
 * already exists — the same way a synced or externally edited vault arrives.
 */
async function seedVault(page: Page, ws: string) {
  await writeStoredMarkdown(
    page,
    ws,
    'library',
    [
      '---',
      'type: Type',
      '_sidebar_label: Library',
      '_icon: stack',
      'color: blue',
      '_order: 1',
      'project: ',
      '---',
      '',
      '# Library',
      '',
    ].join('\n'),
  );
  await writeStoredMarkdown(
    page,
    ws,
    'subject-to-learn',
    '---\ntype: Library\nProject: study\n---\n\n# Subject to Learn\n',
  );
  await writeStoredMarkdown(
    page,
    ws,
    'job-hunting',
    '---\ntype: Library\nProject: work\n---\n\n# Job Hunting\n',
  );
  await writeStoredMarkdown(page, ws, 'loose-note', '# Loose Note\n');
  await writeStoredFile(
    page,
    ws,
    'views/study.yml',
    [
      'name: Study',
      'icon: null',
      'color: null',
      'order: 0',
      'sort: null',
      'filters:',
      '  all:',
      '  - field: Project',
      '    op: equals',
      '    value: study',
    ].join('\n'),
    'text/yaml',
  );
}

test('groups notes by type and lists saved views in the sidebar', async ({
  page,
}) => {
  const workspaceName = 'types-views-sidebar';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await page.reload();

  // The type document supplies the label; its two notes supply the count.
  const libraryRow = page.getByRole('button', { name: /^Library/ });
  await expect(libraryRow).toBeVisible();
  await expect(libraryRow).toContainText('2');

  // Untyped notes must still be reachable, or half a real vault disappears.
  const untypedRow = page.getByRole('button', { name: /^Untyped/ });
  await expect(untypedRow).toBeVisible();
  await expect(untypedRow).toContainText('1');

  // The saved view matches only the note whose Project is "study".
  const studyRow = page.getByRole('button', { name: /^Study/ });
  await expect(studyRow).toBeVisible();
  await expect(studyRow).toContainText('1');

  // A type document describes the vault, so it is not listed as one of its
  // own notes: Library holds 2, not 3.
  await expect(libraryRow).not.toContainText('3');
});

test('selecting a type scopes the note list, and selecting it again clears', async ({
  page,
}) => {
  const workspaceName = 'types-views-filter';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await page.reload();

  // Three notes plus the type document, which is vault configuration.
  await expect(notesTable(page).locator('tbody tr')).toHaveCount(4);

  await page.getByRole('button', { name: /^Library/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Library', exact: true }),
  ).toBeVisible();
  // Scoped to the type: the untyped note is gone.
  await expect(noteRow(page, 'loose-note')).toHaveCount(0);
  await expect(noteRow(page, 'subject-to-learn')).toBeVisible();

  // Selecting the active collection again returns to the whole workspace.
  await page.getByRole('button', { name: /^Library/ }).click();
  await expect(noteRow(page, 'loose-note')).toBeVisible();
});

test('selecting a saved view scopes the note list to its filter', async ({
  page,
}) => {
  const workspaceName = 'types-views-view-filter';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await page.reload();

  await page.getByRole('button', { name: /^Study/ }).click();
  await expect(noteRow(page, 'subject-to-learn')).toBeVisible();
  // job-hunting is the same type but a different Project, so the filter,
  // not the type, is what scoped the list.
  await expect(noteRow(page, 'job-hunting')).toHaveCount(0);
});

test('builds a saved view and persists it as a views/*.yml file', async ({
  page,
}) => {
  const workspaceName = 'types-views-builder';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await page.reload();

  await page.getByRole('button', { name: 'New view' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('View name').fill('Work Items');
  // The field picker offers keys from this vault, not just built-ins.
  await dialog.getByPlaceholder('field').fill('Project');
  await dialog.getByPlaceholder('value').fill('work');
  await dialog.getByRole('button', { name: 'Create view' }).click();

  await expect(dialog).toBeHidden();

  // The view is real: it appears in the sidebar with the count its filter
  // produces, and only the matching note survives the scope.
  const workRow = page.getByRole('button', { name: /^Work Items/ });
  await expect(workRow).toBeVisible();
  await expect(workRow).toContainText('1');

  await workRow.click();
  await expect(noteRow(page, 'job-hunting')).toBeVisible();
  await expect(noteRow(page, 'subject-to-learn')).toHaveCount(0);

  // It survives a reload because it was written to the workspace, not held
  // in memory.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Work Items/ })).toBeVisible();
});

test('an incomplete filter is refused instead of saving a view that matches nothing', async ({
  page,
}) => {
  const workspaceName = 'types-views-invalid';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await page.reload();

  await page.getByRole('button', { name: 'New view' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('View name').fill('Broken');
  await dialog.getByPlaceholder('field').fill('Project');
  // Value left empty on an operator that needs one.
  await dialog.getByRole('button', { name: 'Create view' }).click();

  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: /^Broken/ })).toHaveCount(0);
});

test('a malformed view file does not break the sidebar', async ({ page }) => {
  const workspaceName = 'types-views-malformed';
  await createBrowserWorkspace(page, { workspaceName });
  await seedVault(page, workspaceName);
  await writeStoredFile(
    page,
    workspaceName,
    'views/broken.yml',
    'name: [unclosed',
    'text/yaml',
  );
  await page.reload();

  // The good view still renders; one bad file must not take the list down.
  await expect(page.getByRole('button', { name: /^Study/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Library/ })).toBeVisible();
});
