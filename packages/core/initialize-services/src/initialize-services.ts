import {
  assertIsDefined,
  getEventSenderMetadata,
  throwAppError,
} from '@bangle.io/base-utils';
import type { ThemeManager } from '@bangle.io/color-scheme-manager';
import type { BangleAppCommand } from '@bangle.io/commands';
import {
  DEFAULT_EDITOR_ENGINE,
  EDITOR_ENGINE_QUERY_PARAM,
  type EditorEngineId,
  EXTERNAL_FILE_CHANGE_SENDER_TAG,
  isEditorEngineId,
} from '@bangle.io/constants';
import type { EditorSaveCoordinator } from '@bangle.io/editor';
import { isFileSystemDirectoryHandle } from '@bangle.io/native-fs';
import { slot } from '@bangle.io/poor-mans-di';
import type { WorkspaceOpsService } from '@bangle.io/service-core';
import {
  BrowserErrorHandlerService,
  BrowserLocalStorageSyncDatabaseService,
  BrowserRouterService,
  FileStorageGithub,
  FileStorageIndexedDB,
  FileStorageNativeFs,
  type GithubWorkspaceConfig,
  HashStrategy,
  IdbDatabaseService,
  onPageReturn,
} from '@bangle.io/service-platform';
import type {
  BaseServiceCommonOptions,
  CommandHandler,
  RootEmitter,
} from '@bangle.io/types';
import { createServiceSetup } from './service-setup';

export function readEditorEngineFromUrl(
  location: Pick<Location, 'search'> = window.location,
): EditorEngineId {
  const engineId = new URLSearchParams(location.search).get(
    EDITOR_ENGINE_QUERY_PARAM,
  );
  return isEditorEngineId(engineId) ? engineId : DEFAULT_EDITOR_ENGINE;
}

export function initializeServices(
  commonOpts: BaseServiceCommonOptions,
  rootEmitter: RootEmitter,
  commands: BangleAppCommand[],
  commandHandlers: Array<{ id: string; handler: CommandHandler }>,
  theme: ThemeManager,
  editorSaveCoordinator: EditorSaveCoordinator,
) {
  const editorEngineId = readEditorEngineFromUrl();
  // Native FS root-handle resolution needs workspace metadata, which lives in
  // a core service. The lookup is late-bound: it is wired right after the
  // setup is created and only runs after services are instantiated.
  let getWorkspaceOps: (() => WorkspaceOpsService) | undefined;
  // Same late-binding for the router, whose page-lifecycle stream drives
  // native FS page-return revalidation.
  let getRouter: (() => BrowserRouterService) | undefined;

  const browserPlatformServices = {
    errorService: slot(BrowserErrorHandlerService, () => ({
      onError: (params) => {
        rootEmitter.emit('event::error:uncaught-error', {
          ...params,
          sender: getEventSenderMetadata({ tag: 'BrowserErrorHandlerService' }),
        });
      },
    })),
    database: slot(IdbDatabaseService, () => ({
      onDatabaseInvalidated: () => {
        rootEmitter.emit('event::app:stale-tab', {
          sender: getEventSenderMetadata({ tag: 'IdbDatabaseService' }),
        });
      },
    })),
    syncDatabase: BrowserLocalStorageSyncDatabaseService,
    fileStorageIdb: slot(FileStorageIndexedDB, () => ({
      onChange: (change) => {
        commonOpts.logger.info('File storage change:', change);
      },
    })),
    fileStorageGithub: slot(FileStorageGithub, () => ({
      onChange: (change) => {
        commonOpts.logger.info('File storage change:', change);
      },
      // A sync rewrites files behind the app's back, so its results have to
      // re-enter the same event pipeline external edits use — otherwise an
      // open editor keeps showing content the pull already replaced.
      onSyncStatusChange: (wsName, status) => {
        commonOpts.logger.info('GitHub sync:', wsName, status.type);
        if (status.type === 'done') {
          rootEmitter.emit('event::file:force-update', {
            wsName,
            sender: getEventSenderMetadata({
              tag: EXTERNAL_FILE_CHANGE_SENDER_TAG,
            }),
          });
        }
      },
      getGithubConfig: async (wsName: string) => {
        assertIsDefined(getWorkspaceOps, 'getWorkspaceOps');
        const metadata = await getWorkspaceOps().getWorkspaceMetadata(wsName);
        const config = readGithubMetadata(metadata);
        if (!config) {
          throwAppError(
            'error::workspace:invalid-metadata',
            `Missing GitHub settings for ${wsName}`,
            { wsName },
          );
        }
        return config;
      },
    })),
    fileStorageNativeFs: slot(FileStorageNativeFs, () => ({
      onChange: (change) => {
        commonOpts.logger.info('File storage change:', change);
      },
      // External edits (sync tools, other editors) feed the same typed event
      // pipeline as the app's own file mutations, so the file tree, indexes,
      // and editors react to them identically — the sender tag is what lets
      // consumers tell the two apart.
      onExternalChange: (change) => {
        commonOpts.logger.info('External file storage change:', change);
        const sender = getEventSenderMetadata({
          tag: EXTERNAL_FILE_CHANGE_SENDER_TAG,
        });
        if (change.type === 'refresh') {
          rootEmitter.emit('event::file:force-update', {
            wsName: change.wsName,
            sender,
          });
          return;
        }
        rootEmitter.emit('event::file:update', {
          type: 'file-content-update',
          wsPath: change.wsPath,
          sender,
        });
      },
      subscribePageReturn: (listener, signal) => {
        assertIsDefined(getRouter, 'getRouter');
        onPageReturn(getRouter().emitter, listener, signal);
      },
      getRootDirHandle: async (wsName: string) => {
        assertIsDefined(getWorkspaceOps, 'getWorkspaceOps');
        const { rootDirHandle } =
          await getWorkspaceOps().getWorkspaceMetadata(wsName);

        if (!isFileSystemDirectoryHandle(rootDirHandle)) {
          throwAppError(
            'error::workspace:invalid-metadata',
            `Invalid workspace metadata for ${wsName}`,
            { wsName },
          );
        }

        if (!(await FileStorageNativeFs.hasPermission(rootDirHandle))) {
          throwAppError(
            'error::workspace:native-fs-auth-needed',
            `Need permission for ${rootDirHandle.name}`,
            { wsName },
          );
        }

        return { handle: rootDirHandle };
      },
    })),
    router: slot(BrowserRouterService, () => ({
      strategy: new HashStrategy(window.location.search),
      basePath: '/ws',
    })),
  };

  const setup = createServiceSetup({
    commonOpts,
    rootEmitter,
    commands,
    commandHandlers,
    themeManager: theme,
    shortcutTarget: document,
    platformServices: browserPlatformServices,
    fileStorageSlots: [
      'fileStorageIdb',
      'fileStorageNativeFs',
      'fileStorageGithub',
    ],
    editorEngineId,
    editorSaveCoordinator,
  });

  getWorkspaceOps = () => setup.getServices().workspaceOps;
  getRouter = () => setup.getServices().router;

  setup.instantiate();

  return {
    coreServices: setup.coreServices(),
    mountAll: setup.mountAll,
    describe: setup.describe,
  };
}

/**
 * Pulls the GitHub settings out of a workspace's metadata bag.
 *
 * The token lives here — in IndexedDB alongside the workspace — rather than in
 * localStorage, so it is scoped to the workspace that needs it and disappears
 * with it.
 */
function readGithubMetadata(
  metadata: Record<string, unknown>,
): GithubWorkspaceConfig | undefined {
  const owner = metadata.githubOwner;
  const repo = metadata.githubRepo;
  const branch = metadata.githubBranch;
  const token = metadata.githubToken;

  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof branch !== 'string' ||
    typeof token !== 'string' ||
    !owner ||
    !repo ||
    !branch ||
    !token
  ) {
    return undefined;
  }

  return { owner, repo, branch, token };
}
