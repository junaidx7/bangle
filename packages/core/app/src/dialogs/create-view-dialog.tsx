import { useCoreServices } from '@bangle.io/context';
import { serializeViewDefinition } from '@bangle.io/note-meta';
import { VIEWS_DIRECTORY } from '@bangle.io/service-core';
import { ViewBuilderDialog } from '@bangle.io/ui-components';
import { WsPath } from '@bangle.io/ws-path';
import { useAtom, useAtomValue } from 'jotai';
import React from 'react';

/** Kebab-case, matching the filename convention Tolaria vaults use. */
function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a saved view and writes it as `views/<slug>.yml`.
 *
 * The file is the whole feature: nothing registers the view, the index picks
 * it up on the next rebuild, and it syncs through GitHub like any note. That
 * also means the generated YAML stays deliberately plain, because people edit
 * these by hand afterwards.
 */
export function CreateViewDialog() {
  const coreServices = useCoreServices();
  const [open, setOpen] = useAtom(
    coreServices.workbenchState.$openCreateViewDialog,
  );
  const fields = useAtomValue(coreServices.workspaceState.$filterableFields);
  const views = useAtomValue(coreServices.workspaceState.$noteViews);
  const wsName = useAtomValue(coreServices.workspaceState.$currentWsName);

  return (
    <ViewBuilderDialog
      open={open}
      onOpenChange={setOpen}
      fields={fields}
      validateName={(name) => {
        const slug = toSlug(name);
        if (!slug) {
          return t.app.dialogs.createView.nameRequired;
        }
        return views.some((view) => view.id === slug)
          ? t.app.errors.workspace.viewAlreadyExists({ name })
          : undefined;
      }}
      onCreate={async ({ name, filters }) => {
        if (!wsName) {
          return;
        }
        const slug = toSlug(name);
        const yaml = serializeViewDefinition({
          name,
          order: views.length,
          filters,
        });
        const wsPath = WsPath.fromParts(
          wsName,
          `${VIEWS_DIRECTORY}/${slug}.yml`,
        ).wsPath;

        await coreServices.fileSystem.createTextFile(wsPath, yaml);
        setOpen(false);
      }}
    />
  );
}
