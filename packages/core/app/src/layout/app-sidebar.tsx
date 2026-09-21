import { WORKSPACE_STORAGE_TYPE } from '@bangle.io/constants';
import { useCoreServices } from '@bangle.io/context';
import type { NoteMeta, WorkspaceSyncStatus } from '@bangle.io/service-core';
import { UNTYPED_NOTES_KEY } from '@bangle.io/service-core';
import type {
  SidebarSyncAction,
  SidebarTypeGroup,
} from '@bangle.io/ui-components';
import { Sidebar, AppSidebar as UIAppSidebar } from '@bangle.io/ui-components';
import { WsDirPath, WsPath } from '@bangle.io/ws-path';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import React from 'react';
import { usePwaInstall } from '../common/use-pwa-install';
import { SidebarFooterMenu } from './sidebar-footer-menu';
import { useSidebarFileActions } from './use-sidebar-file-actions';

interface SidebarProps {
  children: React.ReactNode;
}

export const AppSidebar = ({ children }: SidebarProps) => {
  const {
    commandDispatcher,
    workspaceState,
    workbenchState,
    navigation,
    userActivityService,
  } = useCoreServices();
  const setOpenOmniSearch = useSetAtom(workbenchState.$openOmniSearch);
  const workspaces = useAtomValue(workspaceState.$workspaces);
  const [sidebarOpen, setSidebarOpen] = useAtom(workbenchState.$sidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useAtom(workbenchState.$sidebarWidth);
  const [showNoteFilesOnly, setShowNoteFilesOnly] = useAtom(
    workbenchState.$showNoteFilesOnlyInSidebar,
  );
  const fileTreeExpandedPathsByWorkspace = useAtomValue(
    workbenchState.$fileTreeExpandedPathsByWorkspace,
  );
  const activeWsName = useAtomValue(workspaceState.$currentWsName);
  const activeWsPaths = useAtomValue(workspaceState.$activeWsPaths);
  const wsPaths = useAtomValue(workspaceState.$wsPaths);
  const noteWsPaths = useAtomValue(workspaceState.$noteWsPaths);
  const starredWsPaths = useAtomValue(userActivityService.$starredWsPaths);
  const fileTreeListState = useAtomValue(workspaceState.$fileTreeListState);
  const syncStatus = useAtomValue(workbenchState.$syncStatus);
  const noteTypes = useAtomValue(workspaceState.$noteTypes);
  const notesByType = useAtomValue(workspaceState.$notesByType);

  // Keep this domain-to-view join local until another consumer needs it.
  const starredItems = React.useMemo(() => {
    const notesByWsPath = new Map(
      noteWsPaths.map((wsPath) => [wsPath.wsPath, wsPath]),
    );
    const activePathSet = new Set(activeWsPaths.map((wsPath) => wsPath.wsPath));

    return starredWsPaths.flatMap((starredWsPath) => {
      const wsPath = notesByWsPath.get(starredWsPath);
      return wsPath
        ? [
            {
              title: wsPath.fileName || wsPath.path,
              wsPath: wsPath.wsPath,
              isActive: activePathSet.has(wsPath.wsPath),
            },
          ]
        : [];
    });
  }, [activeWsPaths, noteWsPaths, starredWsPaths]);

  const syncAction = useWorkspaceSyncAction({
    activeWsName,
    workspaces,
    syncStatus,
    onSync: () => {
      commandDispatcher.dispatch(
        'command::workspace:sync',
        { wsName: activeWsName },
        'ui',
      );
    },
  });

  const typeGroups = React.useMemo<SidebarTypeGroup[]>(() => {
    const activePathSet = new Set(activeWsPaths.map((wsPath) => wsPath.wsPath));
    const toItems = (notes: readonly NoteMeta[]) =>
      notes.map((note) => ({
        title: note.title,
        wsPath: note.wsPath,
        isActive: activePathSet.has(note.wsPath),
      }));

    const groups: SidebarTypeGroup[] = noteTypes.map((type) => {
      const notes = notesByType.get(type.name) ?? [];
      return {
        key: type.name,
        label: type.label,
        icon: type.icon,
        color: type.color,
        count: notes.length,
        items: toItems(notes),
        typeWsPath: type.wsPath,
      };
    });

    // Untyped notes go last but must be present: most notes in a real vault
    // carry no type, and grouping that hid them would hide the workspace.
    const untyped = notesByType.get(UNTYPED_NOTES_KEY) ?? [];
    if (untyped.length > 0) {
      groups.push({
        key: UNTYPED_NOTES_KEY,
        label: t.app.components.appSidebar.untypedLabel,
        icon: undefined,
        color: undefined,
        count: untyped.length,
        items: toItems(untyped),
        typeWsPath: undefined,
      });
    }

    return groups;
  }, [noteTypes, notesByType, activeWsPaths]);

  const getActionsForEntry = useSidebarFileActions({
    activeWsName,
    commandDispatcher,
  });

  const pwaInstall = usePwaInstall();
  const pwaAction = React.useMemo(() => {
    if (pwaInstall.canInstall || pwaInstall.isInstalling) {
      return {
        kind: 'install' as const,
        label: pwaInstall.isInstalling
          ? t.app.sidebar.installingApp
          : t.app.sidebar.installApp,
        disabled: pwaInstall.isInstalling,
        onClick: () => {
          void pwaInstall.install();
        },
      };
    }

    if (pwaInstall.canOpenInApp) {
      return {
        kind: 'open-in-app' as const,
        label: t.app.sidebar.openInApp,
        onClick: () => {
          pwaInstall.openInApp();
        },
      };
    }

    return undefined;
  }, [pwaInstall]);

  const handleFileTreeDirectoryExpansionChange = React.useCallback(
    (path: string, expanded: boolean) => {
      if (activeWsName) {
        workbenchState.setFileTreeDirectoryExpanded(
          activeWsName,
          path,
          expanded,
        );
      }
    },
    [activeWsName, workbenchState],
  );
  const handleRevealFileTreePaths = React.useCallback(
    (paths: readonly string[]) => {
      if (activeWsName) {
        workbenchState.revealFileTreePaths(activeWsName, paths);
      }
    },
    [activeWsName, workbenchState],
  );
  const handleCollapseFileTree = React.useCallback(
    (keepExpandedPaths: readonly string[]) => {
      if (activeWsName) {
        workbenchState.collapseFileTree(activeWsName, keepExpandedPaths);
      }
    },
    [activeWsName, workbenchState],
  );

  return (
    <Sidebar.SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => setSidebarOpen(open)}
      width={sidebarWidth}
      onWidthChange={setSidebarWidth}
    >
      <UIAppSidebar
        workspaces={workspaces.map((ws, _i) => ({
          name: ws.name,
          misc: ws.type,
          isActive: activeWsName === ws.name,
        }))}
        filePaths={(showNoteFilesOnly ? noteWsPaths : wsPaths).map(
          (wsPath) => wsPath.path,
        )}
        navItems={activeWsPaths.map((wsPath) => ({
          title: wsPath.fileName || '',
          wsPath: wsPath.wsPath,
        }))}
        starredItems={starredItems}
        wsPathToHref={(wsPath) => navigation.toWsFileUri(wsPath)}
        wsNameToHref={(wsName) =>
          navigation.toUri({
            route: 'ws-home',
            payload: { wsName },
          })
        }
        canCreateFiles={Boolean(activeWsName)}
        syncAction={syncAction}
        typeGroups={typeGroups}
        onCreateDirectory={(pathPrefix) => {
          if (!activeWsName) {
            return;
          }
          commandDispatcher.dispatch(
            'command::ui:create-directory-dialog',
            {
              pathPrefix,
            },
            'ui',
          );
        }}
        onCreateNote={(pathPrefix) => {
          if (!activeWsName) {
            return;
          }
          commandDispatcher.dispatch(
            'command::ws:quick-new-note',
            {
              pathPrefix,
            },
            'ui',
          );
        }}
        onMoveFile={(sourceRelativePath, destinationDirectory) => {
          if (!activeWsName) {
            return;
          }

          commandDispatcher.dispatch(
            'command::ws:move-ws-path',
            {
              destDirWsPath: destinationDirectory
                ? WsDirPath.fromParts(activeWsName, destinationDirectory).wsPath
                : `${activeWsName}:`,
              wsPath: WsPath.fromParts(activeWsName, sourceRelativePath).wsPath,
            },
            'ui',
          );
        }}
        onOpenFile={(relativePath) => {
          if (!activeWsName) {
            return;
          }

          commandDispatcher.dispatch(
            'command::ws:go-ws-path',
            {
              wsPath: WsPath.fromParts(activeWsName, relativePath).wsPath,
            },
            'ui',
          );
        }}
        onNewWorkspaceClick={() => {
          commandDispatcher.dispatch(
            'command::ui:create-workspace-dialog',
            null,
            'ui',
          );
        }}
        onManageWorkspacesClick={() => {
          commandDispatcher.dispatch(
            'command::ui:open-settings-workspaces',
            null,
            'ui',
          );
        }}
        fileTreeNotice={
          fileTreeListState.status === 'error'
            ? {
                message: t.app.components.appSidebar.fileTreeErrorMessage,
                retryLabel: t.app.components.appSidebar.fileTreeErrorRetry,
                onRetry: () => {
                  commandDispatcher.dispatch(
                    'command::ws:refresh-file-tree',
                    null,
                    'ui',
                  );
                },
              }
            : undefined
        }
        activeFilePaths={activeWsPaths.map((wsPath) => wsPath.path)}
        expandedFileTreePaths={
          activeWsName &&
          Object.hasOwn(fileTreeExpandedPathsByWorkspace, activeWsName)
            ? fileTreeExpandedPathsByWorkspace[activeWsName]
            : undefined
        }
        onFileTreeDirectoryExpansionChange={
          handleFileTreeDirectoryExpansionChange
        }
        onRevealFileTreePaths={handleRevealFileTreePaths}
        onCollapseFileTree={handleCollapseFileTree}
        commandButtonClassName="desktop-titlebar-no-drag"
        showNoteFilesOnly={showNoteFilesOnly}
        onShowNoteFilesOnlyChange={setShowNoteFilesOnly}
        onSearchClick={() => {
          setOpenOmniSearch(true);
        }}
        sidebarHeaderClassName="desktop-sidebar-titlebar-header desktop-titlebar-drag"
        workspaceSwitcherWrapperClassName="desktop-titlebar-no-drag"
        getActionsForEntry={getActionsForEntry}
        pwaAction={pwaAction}
        footerTitle={t.app.sidebar.footerTitle}
        footerChildren={
          <SidebarFooterMenu canCreateFiles={Boolean(activeWsName)} />
        }
      />
      <Sidebar.SidebarInset>{children}</Sidebar.SidebarInset>
    </Sidebar.SidebarProvider>
  );
};

/**
 * Surfaces a sync control only for workspaces that actually have a remote.
 *
 * Status is read from workbench state, which the sync command writes, so the
 * button reflects what actually happened rather than guessing from a timer.
 */
function useWorkspaceSyncAction({
  activeWsName,
  workspaces,
  syncStatus,
  onSync,
}: {
  activeWsName: string | undefined;
  workspaces: ReadonlyArray<{ name: string; type: string }>;
  syncStatus: WorkspaceSyncStatus;
  onSync: () => void;
}): SidebarSyncAction | undefined {
  const isGithub = React.useMemo(() => {
    if (!activeWsName) return false;
    return (
      workspaces.find((workspace) => workspace.name === activeWsName)?.type ===
      WORKSPACE_STORAGE_TYPE.Github
    );
  }, [activeWsName, workspaces]);

  if (!isGithub || !activeWsName) {
    return undefined;
  }

  // Status carries the workspace it belongs to, so switching workspaces shows
  // a clean button instead of the previous workspace's result.
  const relevant =
    syncStatus.type !== 'idle' && syncStatus.wsName === activeWsName
      ? syncStatus
      : undefined;

  if (relevant?.type === 'syncing') {
    return { status: 'syncing', onSync };
  }
  if (relevant?.type === 'error') {
    return { status: 'error', detail: relevant.message, onSync };
  }
  if (relevant?.type === 'done') {
    return { status: 'idle', detail: relevant.summary, onSync };
  }

  return { status: 'idle', onSync };
}
