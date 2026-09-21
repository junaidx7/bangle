import { throwAppError } from '@bangle.io/base-utils';
import { WORKSPACE_STORAGE_TYPE } from '@bangle.io/constants';
import { useCoreServices } from '@bangle.io/context';
import { GithubApi, isGithubApiError } from '@bangle.io/github-api';
import { pickDirectory, supportsNativeFs } from '@bangle.io/native-fs';
import type {
  GithubVerifyResult,
  GithubWorkspaceInput,
} from '@bangle.io/ui-components';
import { CreateWorkspaceDialog as UICreateWorkspaceDialog } from '@bangle.io/ui-components';
import { WsPath } from '@bangle.io/ws-path';
import { useAtom } from 'jotai';
import React from 'react';
import { nativeFsErrorParse } from '../common';

/** A dialog component for creating a new workspace, allowing selection of storage type. */
export function CreateWorkspaceDialog() {
  const coreServices = useCoreServices();
  const [openWsDialog, setOpenWsDialog] = useAtom(
    coreServices.workbenchState.$openWsDialog,
  );
  return (
    <UICreateWorkspaceDialog
      open={openWsDialog}
      onOpenChange={setOpenWsDialog}
      validateWorkspace={({ name: wsName }) => {
        const result = WsPath.safeFromParts(wsName, '');
        if (result.ok) {
          return { isValid: true };
        }

        return {
          isValid: false,
          message:
            result.validationError?.reason ||
            t.app.dialogs.createWorkspace.invalidName,
        };
      }}
      onDone={async ({ name: wsName, type, dirHandle, github }) => {
        if (type === WORKSPACE_STORAGE_TYPE.Github) {
          if (!github) {
            throwAppError(
              'error::workspace:invalid-metadata',
              `GitHub settings for ${wsName} are missing`,
              { wsName },
            );
          }

          await coreServices.workspaceOps.createWorkspaceInfo({
            name: wsName,
            type,
            metadata: {
              githubOwner: github.owner,
              githubRepo: github.repo,
              githubBranch: github.branch,
              githubToken: github.token,
            },
          });
          setOpenWsDialog(false);
          coreServices.navigation.goWorkspace(wsName);
          return;
        }

        if (type === WORKSPACE_STORAGE_TYPE.NativeFS) {
          if (!dirHandle) {
            throwAppError(
              'error::workspace:invalid-metadata',
              `Directory handle for ${wsName} is invalid `,
              {
                wsName: wsName,
              },
            );
          }

          await coreServices.workspaceOps.createWorkspaceInfo({
            name: wsName,
            type,
            metadata: {
              rootDirHandle: dirHandle,
            },
          });
          setOpenWsDialog(false);
          coreServices.navigation.goWorkspace(wsName);
          return;
        }

        if (type === WORKSPACE_STORAGE_TYPE.Browser) {
          await coreServices.workspaceOps.createWorkspaceInfo({
            metadata: {},
            name: wsName,
            type: WORKSPACE_STORAGE_TYPE.Browser,
          });
          setOpenWsDialog(false);
          coreServices.navigation.goWorkspace(wsName);
          return;
        }

        throwAppError(
          'error::workspace:unknown-ws-type',
          'Unknown workspace type',
          {
            wsName: wsName,
            type,
          },
        );
      }}
      storageTypes={[
        {
          type: WORKSPACE_STORAGE_TYPE.Browser,
          title: t.app.dialogs.createWorkspace.browserTitle,
          description: t.app.dialogs.createWorkspace.browserDescription,
        },
        {
          type: WORKSPACE_STORAGE_TYPE.NativeFS,
          title: t.app.dialogs.createWorkspace.nativeFsTitle,
          description: t.app.dialogs.createWorkspace.nativeFsDescription,
          disabled: !supportsNativeFs(),
        },
        {
          type: WORKSPACE_STORAGE_TYPE.Github,
          title: t.app.dialogs.createWorkspace.githubTitle,
          description: t.app.dialogs.createWorkspace.githubDescription,
        },
      ]}
      onGithubVerify={verifyGithubAccess}
      onDirectoryPick={async () => {
        try {
          const dirHandle = await pickDirectory({ id: 'bangle-workspace' });
          return { type: 'success', dirHandle };
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }

          return nativeFsErrorParse(error);
        }
      }}
    />
  );
}

/**
 * Checks the repo and token before the workspace exists.
 *
 * Failing here means a typo or an under-scoped token surfaces while the fields
 * are still on screen, instead of as a sync error against a workspace the user
 * has already started putting notes in.
 */
async function verifyGithubAccess(
  input: GithubWorkspaceInput,
): Promise<GithubVerifyResult> {
  const api = new GithubApi(input);

  try {
    const access = await api.verifyAccess();

    if (!access.branchExists) {
      return {
        type: 'error',
        errorInfo: {
          message: t.app.dialogs.createWorkspace.githubBranchMissing({
            branch: input.branch,
          }),
        },
      };
    }

    if (!access.canPush) {
      return {
        type: 'error',
        errorInfo: { message: t.app.dialogs.createWorkspace.githubNoPush },
      };
    }

    return { type: 'success' };
  } catch (error) {
    if (isGithubApiError(error)) {
      if (error.code === 'auth') {
        return {
          type: 'error',
          errorInfo: {
            message: t.app.dialogs.createWorkspace.githubAuthFailed,
          },
        };
      }
      if (error.code === 'not-found') {
        // GitHub answers 404 both for a repository that does not exist and for
        // one this token may not see. Asking who the token belongs to tells the
        // two apart, so the message can name the actual fix.
        const login = await api.getAuthenticatedLogin();
        return {
          type: 'error',
          errorInfo: {
            message: login
              ? t.app.dialogs.createWorkspace.githubRepoNotFoundForToken({
                  login,
                  owner: input.owner,
                  repo: input.repo,
                })
              : t.app.dialogs.createWorkspace.githubRepoNotFound,
          },
        };
      }
    }
    return {
      type: 'error',
      errorInfo: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
