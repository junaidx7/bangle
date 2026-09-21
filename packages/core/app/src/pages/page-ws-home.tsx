import { useCoreServices } from '@bangle.io/context';
import type { SelectedCollection } from '@bangle.io/service-core';
import { Button, FunMissing } from '@bangle.io/ui-components';
import { useAtomValue, useSetAtom } from 'jotai';
import React from 'react';
import { Actions } from '../components/common/actions';
import { ContentSection } from '../components/common/content-section';
import { PageHeader } from '../components/common/page-header';
import { NoticeView } from '../components/feedback/notice-view';
import {
  NotesTable,
  type NotesTableNote,
} from '../components/notes-table/notes-table';
import { AppHeader } from '../layout/app-header';
import { PageContentContainer } from '../layout/main-content-container';

/**
 * This is the home page for a given workspace. It lists every note in a
 * sortable, filterable table, alongside actions to create a new note or
 * switch workspace.
 */
export function PageWsHome() {
  const coreServices = useCoreServices();
  const currentWsName = useAtomValue(
    coreServices.workspaceState.$currentWsName,
  );
  const selectedCollection = useAtomValue(
    coreServices.workbenchState.$selectedCollection,
  );
  const notes = useNotesTableData(selectedCollection);
  const clearCollection = useSetAtom(
    coreServices.workbenchState.$selectedCollection,
  );

  const onNewNote = () =>
    coreServices.commandDispatcher.dispatch(
      'command::ui:create-note-dialog',
      { prefillName: undefined },
      'ui',
    );
  const onSwitchWorkspace = () =>
    coreServices.commandDispatcher.dispatch(
      'command::ui:switch-workspace',
      null,
      'ui',
    );

  return (
    <>
      <AppHeader />
      <PageContentContainer testId="page-ws-home">
        {currentWsName ? (
          notes.length > 0 ? (
            <ContentSection hasPadding>
              <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="wrap-anywhere min-w-0 font-semibold text-2xl tracking-tight">
                      {selectedCollection?.label ?? currentWsName}
                    </h2>
                    {selectedCollection && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 text-xs"
                        onClick={() => clearCollection(undefined)}
                      >
                        {t.app.pageWsHome.clearCollectionButton}
                      </Button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" onClick={onSwitchWorkspace}>
                      {t.app.pageWsHome.switchWorkspaceButton}
                    </Button>
                    <Button onClick={onNewNote}>
                      {t.app.pageWsHome.newNoteButton}
                    </Button>
                  </div>
                </div>
                <NotesTable notes={notes} />
              </div>
            </ContentSection>
          ) : (
            <ContentSection hasPadding>
              <PageHeader title={`${currentWsName}`} />
              <div className="py-4 text-center text-muted-foreground text-sm">
                {t.app.pageWsHome.noNotesMessage}
              </div>
              <Actions
                actions={[
                  {
                    label: t.app.pageWsHome.newNoteButton,
                    onClick: onNewNote,
                  },
                  {
                    label: t.app.pageWsHome.switchWorkspaceButton,
                    variant: 'outline',
                    onClick: onSwitchWorkspace,
                  },
                ]}
              />
            </ContentSection>
          )
        ) : (
          <ContentSection hasPadding>
            <NoticeView
              title={t.app.pageWorkspaceNotFound.title}
              description={<FunMissing />}
              actions={[
                {
                  label: t.app.pageWorkspaceNotFound.createWorkspaceButton,
                  onClick: () =>
                    coreServices.commandDispatcher.dispatch(
                      'command::ui:create-workspace-dialog',
                      null,
                      'ui',
                    ),
                },
                {
                  label: t.app.pageWorkspaceNotFound.switchWorkspaceButton,
                  variant: 'outline',
                  onClick: () =>
                    coreServices.commandDispatcher.dispatch(
                      'command::ui:switch-workspace',
                      null,
                      'ui',
                    ),
                },
              ]}
            />
          </ContentSection>
        )}
      </PageContentContainer>
    </>
  );
}

/**
 * Assembles table rows from the note listing, user activity (last opened,
 * starred) and file stats. Rows are pre-ordered by last-opened recency so the
 * table shows a sensible order even before file stats stream in.
 */
function useNotesTableData(
  selectedCollection: SelectedCollection | undefined,
): NotesTableNote[] {
  const coreServices = useCoreServices();
  const allNoteWsPaths = useAtomValue(coreServices.workspaceState.$noteWsPaths);
  const notesByType = useAtomValue(coreServices.workspaceState.$notesByType);
  const notesByView = useAtomValue(coreServices.workspaceState.$notesByView);

  // Scoping happens on paths rather than on finished rows so the table keeps
  // its stats, starring and recency behaviour unchanged.
  const noteWsPaths = React.useMemo(() => {
    if (!selectedCollection) {
      return allNoteWsPaths;
    }
    const matched =
      selectedCollection.kind === 'view'
        ? notesByView.get(selectedCollection.key)
        : notesByType.get(selectedCollection.key);
    const allowed = new Set((matched ?? []).map((note) => note.wsPath));
    return allNoteWsPaths.filter((path) => allowed.has(path.wsPath));
  }, [allNoteWsPaths, notesByType, notesByView, selectedCollection]);
  const allRecentWsPaths = useAtomValue(
    coreServices.userActivityService.$allRecentWsPaths,
  );
  const starredPaths = useAtomValue(
    coreServices.userActivityService.$starredWsPaths,
  );
  const stats = useAtomValue(coreServices.workspaceState.$noteFileStats);

  return React.useMemo(() => {
    const lastOpenedByWsPath = new Map(
      allRecentWsPaths.map(({ wsPath, timestamp }) => [wsPath, timestamp]),
    );
    const starredSet = new Set(starredPaths);

    return noteWsPaths
      .map((filePath): NotesTableNote => {
        const stat = stats.get(filePath.wsPath);
        const parent = filePath.getParent();
        const dirPath =
          parent && !parent.isRoot ? parent.path.replace(/\/$/, '') : '';
        return {
          wsPath: filePath.wsPath,
          fileName: filePath.fileNameWithoutExtension,
          dirPath,
          href: coreServices.navigation.toUri({
            route: 'editor',
            payload: { wsPath: filePath.wsPath },
          }),
          isStarred: starredSet.has(filePath.wsPath),
          lastOpenedAt: lastOpenedByWsPath.get(filePath.wsPath),
          modifiedAt: stat?.mtime,
        };
      })
      .sort(
        (a, b) =>
          (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) ||
          a.fileName.localeCompare(b.fileName),
      );
  }, [
    noteWsPaths,
    allRecentWsPaths,
    starredPaths,
    stats,
    coreServices.navigation,
  ]);
}
