import {
  Button,
  buttonVariants,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@bangle.io/base-ui';
import { KEYBOARD_SHORTCUTS } from '@bangle.io/constants';
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Download,
  ExternalLink,
  Files,
  FileText,
  Filter,
  GalleryVerticalEnd,
  Layers,
  Lightbulb,
  List,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Tag,
  TriangleAlert,
} from 'lucide-react';
import React from 'react';
import bangleIcon from './bangle-transparent_x512.png';
import {
  type FileTreeEntry,
  type FileTreeEntryAction,
  PierreFileTree,
} from './file-tree';
import { KbdShortcut } from './kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from './sidebar';

export type NavItem = {
  title: string;
  wsPath: string;
  isActive?: boolean;
  items?: NavItem[];
};

/**
 * One collapsible section of notes sharing a type.
 *
 * `icon` and `color` arrive as the strings a type document declares, not as
 * components: the vault is the source of truth and may name an icon this app
 * has never heard of, so resolving happens here and unknown names degrade to
 * a default rather than breaking the sidebar.
 */
/**
 * One row under a VIEWS or TYPES heading: an icon, a label, and how many
 * notes it holds. Selecting it lists those notes in the main pane rather
 * than nesting them in the sidebar, so a vault with many types stays
 * navigable.
 *
 * `icon` and `color` arrive as the strings the vault declared, not as
 * components: the vault is the source of truth and may name an icon this app
 * has never heard of, so resolving happens here and unknown names degrade to
 * a default rather than breaking the sidebar.
 */
export type SidebarCollectionItem = {
  key: string;
  label: string;
  icon?: string | undefined;
  color?: string | undefined;
  count: number;
  isActive?: boolean;
  onSelect: () => void;
};

export type SidebarCollection = {
  label: string;
  items: SidebarCollectionItem[];
  /** Shown as a `+` in the heading; omitted when adding is not offered. */
  onAdd?: (() => void) | undefined;
  addLabel?: string | undefined;
};

type Workspace = {
  name: string;
  logo?: React.ElementType;
  misc: string;
  isActive?: boolean;
};

export interface SidebarSyncAction {
  status: 'idle' | 'syncing' | 'error';
  /** Short line under the button: last sync time, or what went wrong. */
  detail?: string;
  onSync: () => void;
}

export type AppSidebarProps = {
  canCreateFiles: boolean;
  /**
   * Present only for workspaces backed by a remote. Given first-class space
   * rather than hiding behind the command palette, because on a phone the
   * palette is the least reachable part of the app and syncing is the one
   * action a remote workspace genuinely needs.
   */
  syncAction?: SidebarSyncAction;
  onNewWorkspaceClick: () => void;
  onManageWorkspacesClick: () => void;
  workspaces: Workspace[];
  filePaths: string[];
  navItems: NavItem[];
  starredItems?: NavItem[];
  /** Saved views, already ordered for display. */
  viewCollection?: SidebarCollection | undefined;
  /** Note types discovered in the workspace, already ordered for display. */
  typeCollection?: SidebarCollection | undefined;
  onSearchClick?: () => void;
  activeFilePaths?: string[];
  getActionsForEntry: (
    entry: FileTreeEntry,
    selectedEntries: readonly FileTreeEntry[],
  ) => readonly FileTreeEntryAction[];
  onCreateDirectory: (pathPrefix: string | undefined) => void;
  onCreateNote: (pathPrefix: string | undefined) => void;
  onMoveFile: (
    sourceRelativePath: string,
    destinationDirectory: string | undefined,
  ) => void;
  onOpenFile: (relativePath: string) => void;
  showNoteFilesOnly: boolean;
  onShowNoteFilesOnlyChange: (showNoteFilesOnly: boolean) => void;
  expandedFileTreePaths?: readonly string[];
  onFileTreeDirectoryExpansionChange: (path: string, expanded: boolean) => void;
  onRevealFileTreePaths: (paths: readonly string[]) => void;
  onCollapseFileTree: (keepExpandedPaths: readonly string[]) => void;
  /**
   * When set, renders a recoverable error notice above the file tree, e.g.
   * after a failed workspace file scan. The tree below keeps showing the last
   * known files.
   */
  fileTreeNotice?: {
    message: string;
    retryLabel: string;
    onRetry: () => void;
  };
  /**
   * When set, renders a persistent accent action pill above the sidebar
   * footer, e.g. "Install app" while the browser offers a PWA install, or
   * "Open in app" when the installed PWA is available from a browser tab.
   */
  pwaAction?: {
    kind: 'install' | 'open-in-app';
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  footerChildren?: React.ReactNode;
  footerTitle?: string;
  footerSubtitle?: string;
  wsPathToHref?: (wsPath: string) => string;
  wsNameToHref: (wsName: string) => string;
  sidebarHeaderClassName?: string;
  workspaceSwitcherWrapperClassName?: string;
  commandButtonClassName?: string;
};

interface DropdownButtonProps {
  icon?: React.ElementType;
  imageSrc?: string;
  title: string;
  subtitle: string;
  fancy?: boolean;
  density?: 'default' | 'compact';
  className?: string;
}

function DropdownButton({
  icon: IconComponent,
  imageSrc,
  title,
  subtitle,
  fancy = false,
  density = 'default',
  className,
}: DropdownButtonProps) {
  const isCompact = density === 'compact';
  const getButtonClass = (isFancy: boolean) =>
    cn(
      'data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground',
      isCompact && 'h-10 rounded-md px-2',
      isFancy &&
        'shadow-[0_0_20px_rgba(0,0,0,0.15)] dark:shadow-[0_2px_25px_rgba(255,255,255,0.25)]' +
          'border border-sidebar-accent dark:border-sidebar-accent-foreground',
      className,
    );

  const textClass = cn(
    'grid flex-1 text-left text-sm leading-tight select-none',
    fancy && 'font-bold tracking-tight',
  );

  const subtitleClass = cn(
    'truncate text-xs',
    isCompact && 'text-[11px] leading-3',
    fancy && 'font-medium',
  );

  return (
    <DropdownMenuTrigger
      render={
        <SidebarMenuButton
          size={isCompact ? 'default' : 'lg'}
          className={cn(getButtonClass(fancy))}
        >
          {imageSrc ? (
            <div
              className={cn(
                'flex aspect-square items-center justify-center overflow-hidden rounded-lg text-sidebar-primary-foreground',
                isCompact ? 'size-7' : 'size-10',
              )}
            >
              <img
                src={imageSrc}
                alt={title}
                className={cn(
                  'select-none object-contain',
                  isCompact ? 'size-5.5' : 'size-8',
                )}
              />
            </div>
          ) : (
            IconComponent && (
              <div
                className={cn(
                  'flex aspect-square items-center justify-center rounded-lg',
                  isCompact ? 'size-7' : 'size-8',
                )}
              >
                <IconComponent className={isCompact ? 'size-3.5' : 'size-4'} />
              </div>
            )
          )}
          <div className={textClass}>
            <span
              className={cn(
                'font-semibold',
                isCompact && 'leading-4',
                fancy && 'text-base leading-snug',
              )}
            >
              {title}
            </span>
            <span className={subtitleClass}>{subtitle}</span>
          </div>
          <ChevronsUpDown className="!size-3.5 ml-auto text-sidebar-foreground/55" />
        </SidebarMenuButton>
      }
    />
  );
}

export function AppSidebar({
  canCreateFiles,
  onNewWorkspaceClick,
  onManageWorkspacesClick,
  workspaces,
  filePaths,
  navItems,
  starredItems = [],
  viewCollection,
  typeCollection,
  onSearchClick = () => {},
  syncAction,
  activeFilePaths = [],
  getActionsForEntry,
  onCreateDirectory,
  onCreateNote,
  onMoveFile,
  onOpenFile,
  expandedFileTreePaths,
  onFileTreeDirectoryExpansionChange,
  onRevealFileTreePaths,
  onCollapseFileTree,
  showNoteFilesOnly,
  onShowNoteFilesOnlyChange,
  fileTreeNotice,
  pwaAction,
  footerChildren,
  footerTitle,
  footerSubtitle,
  wsPathToHref,
  wsNameToHref,
  sidebarHeaderClassName,
  workspaceSwitcherWrapperClassName,
  commandButtonClassName,
}: AppSidebarProps) {
  return (
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <SidebarHeader className={cn('gap-2 px-3 py-2', sidebarHeaderClassName)}>
        <div className={workspaceSwitcherWrapperClassName}>
          <WorkspaceSwitcher
            workspaces={workspaces}
            onNewWorkspaceClick={onNewWorkspaceClick}
            onManageWorkspacesClick={onManageWorkspacesClick}
            wsNameToHref={wsNameToHref}
          />
        </div>
        <CommandButton
          className={commandButtonClassName}
          onClick={() => onSearchClick?.()}
        />
      </SidebarHeader>
      <SidebarContent className="gap-1 overflow-hidden">
        <SidebarNavGroup
          items={navItems}
          label={t.app.components.appSidebar.openedLabel}
          wsPathToHref={wsPathToHref}
        />
        <SidebarNavGroup
          items={starredItems}
          label={t.app.components.appSidebar.starredLabel}
          wsPathToHref={wsPathToHref}
          icon={Star}
          scrollable
        />
        {viewCollection && <SidebarCollectionGroup {...viewCollection} />}
        {typeCollection && <SidebarCollectionGroup {...typeCollection} />}
        <SidebarGroup className="min-h-0 flex-1 overflow-hidden p-0 pt-0">
          <SidebarGroupLabel className="sr-only">
            {t.app.components.appSidebar.filesLabel}
          </SidebarGroupLabel>
          <SidebarGroupContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {syncAction && <SidebarSyncButton {...syncAction} />}
            {fileTreeNotice && (
              <div
                role="alert"
                className="mx-2 mb-1 flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-destructive text-xs"
              >
                <span>{fileTreeNotice.message}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 w-fit px-2 text-xs"
                  onClick={() => fileTreeNotice.onRetry()}
                >
                  {fileTreeNotice.retryLabel}
                </Button>
              </div>
            )}
            <PierreFileTree
              canCreateFiles={canCreateFiles}
              activePaths={activeFilePaths}
              filePaths={filePaths}
              getActionsForEntry={getActionsForEntry}
              onCreateDirectory={onCreateDirectory}
              onCreateNote={onCreateNote}
              onMoveFile={onMoveFile}
              onOpenFile={onOpenFile}
              expandedPaths={expandedFileTreePaths}
              onDirectoryExpansionChange={onFileTreeDirectoryExpansionChange}
              onRevealPaths={onRevealFileTreePaths}
              onCollapseAll={onCollapseFileTree}
              showNoteFilesOnly={showNoteFilesOnly}
              onShowNoteFilesOnlyChange={onShowNoteFilesOnlyChange}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {pwaAction && <SidebarPwaAction {...pwaAction} />}
      {footerChildren && (
        <AppSidebarFooter
          title={footerTitle}
          subtitle={footerSubtitle}
          dropdownPosition="top"
        >
          {footerChildren}
        </AppSidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  );
}

function SidebarNavGroup({
  items,
  label,
  wsPathToHref,
  icon: Icon,
  scrollable = false,
}: {
  items: NavItem[];
  label: string;
  wsPathToHref?: (wsPath: string) => string;
  icon?: React.ElementType;
  scrollable?: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();

  if (items.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu
        className={cn(
          'gap-1',
          scrollable && 'max-h-[min(10rem,25vh)] overflow-y-auto pr-1',
        )}
      >
        {items.map((item) => (
          <SidebarMenuItem key={item.wsPath} className="min-w-0">
            <SidebarMenuButton
              isActive={item.isActive}
              render={
                <a
                  href={wsPathToHref ? wsPathToHref(item.wsPath) : '#dead'}
                  title={item.title}
                  aria-current={item.isActive ? 'page' : undefined}
                  className="min-w-0 font-medium"
                  onClick={() => {
                    if (isMobile) {
                      setOpenMobile(false);
                    }
                  }}
                />
              }
            >
              {Icon && (
                <Icon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 fill-current text-amber-500"
                />
              )}
              <span className="block min-w-0 truncate">{item.title}</span>
            </SidebarMenuButton>
            {item.items?.length ? (
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                {item.items.map((childItem) => (
                  <SidebarMenuSubItem
                    key={childItem.wsPath}
                    className="min-w-0"
                  >
                    <SidebarMenuSubButton
                      render={
                        <a
                          href={
                            wsPathToHref
                              ? wsPathToHref(childItem.wsPath)
                              : '#dead'
                          }
                          title={childItem.title}
                          className="min-w-0"
                          onClick={() => {
                            if (isMobile) {
                              setOpenMobile(false);
                            }
                          }}
                        />
                      }
                    >
                      <span className="block min-w-0 truncate">
                        {childItem.title}
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function SidebarPwaAction({
  kind,
  label,
  onClick,
  disabled,
}: {
  kind: 'install' | 'open-in-app';
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = kind === 'install' ? Download : ExternalLink;

  return (
    <div className="px-3 pt-1">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        data-testid="sidebar-pwa-action"
        className="w-full justify-center gap-2 border-pop/40 bg-pop/10 font-medium hover:bg-pop/20"
      >
        <Icon aria-hidden="true" className="size-3.5 text-pop" />
        <span>{label}</span>
      </Button>
    </div>
  );
}

function AppSidebarFooter({
  children,
  title = 'Bangle.io',
  subtitle = '',
  dropdownPosition = 'right',
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  dropdownPosition?: 'bottom' | 'right' | 'top' | 'left';
}) {
  const { isMobile } = useSidebar();

  return (
    <SidebarFooter className="px-3 py-2">
      <DropdownMenu>
        <DropdownButton
          imageSrc={bangleIcon}
          title={title}
          subtitle={subtitle}
          fancy={true}
        />
        <DropdownMenuContent
          className="w-(--anchor-width) min-w-56 rounded-lg"
          align="start"
          side={isMobile ? 'top' : dropdownPosition}
          sideOffset={4}
          finalFocus={false}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarFooter>
  );
}

function CommandButton({
  className,
  onClick,
}: {
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={t.app.common.searchLabel}
      onClick={onClick}
      className={cn('w-full cursor-pointer text-left', className)}
    >
      <SidebarGroup className="p-0">
        <SidebarGroupContent className="relative">
          <div className="flex h-8 w-full items-center rounded-md border border-input bg-background/70 pr-8 pl-8 text-muted-foreground text-sm shadow-none">
            {t.app.common.searchInputPlaceholder}
          </div>
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 select-none opacity-50" />
          <div className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm opacity-70">
            <KbdShortcut keys={KEYBOARD_SHORTCUTS.toggleOmniSearch.keys} />
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    </button>
  );
}

function WorkspaceSwitcher({
  workspaces,
  onNewWorkspaceClick,
  onManageWorkspacesClick,
  wsNameToHref,
}: {
  workspaces: Workspace[];
  onNewWorkspaceClick: () => void;
  onManageWorkspacesClick: () => void;
  wsNameToHref: (wsName: string) => string;
}) {
  const { isMobile } = useSidebar();

  const activeWs = workspaces.find((ws) => ws.isActive);

  const Logo = activeWs?.logo ?? GalleryVerticalEnd;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownButton
            icon={Logo}
            density="compact"
            title={
              activeWs
                ? activeWs.name
                : t.app.components.appSidebar.noWorkspaceSelectedTitle
            }
            subtitle={
              activeWs
                ? activeWs.misc
                : t.app.components.appSidebar.noWorkspaceSelectedSubtitle
            }
            className={
              !activeWs
                ? 'bg-sidebar-accent/70 hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent'
                : undefined
            }
          />

          <DropdownMenuContent
            className="max-h-[400px] w-(--anchor-width) min-w-56 overflow-y-auto rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
            finalFocus={false}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t.app.components.appSidebar.workspacesLabel}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={onNewWorkspaceClick}
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <span className="">{t.app.common.newWorkspace}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {workspaces.map((workspace) => {
              const LogoComponent = workspace.logo
                ? workspace.logo
                : GalleryVerticalEnd;

              return (
                <DropdownMenuItem
                  key={workspace.name}
                  className={cn(
                    'gap-2 p-2',
                    workspace.isActive && 'font-medium text-foreground',
                  )}
                  render={
                    <a
                      href={wsNameToHref(workspace.name)}
                      className="flex items-center"
                    />
                  }
                >
                  <div className="flex size-6 items-center justify-center rounded-sm border">
                    <LogoComponent className="size-4 shrink-0" />
                  </div>
                  <span className={workspace.isActive ? 'underline' : ''}>
                    {workspace.name}
                  </span>
                  {workspace.isActive && (
                    <span className="ml-2 inline-block h-2 w-2 rounded-full bg-pop" />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t.app.components.appSidebar.manageLabel}
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={onManageWorkspacesClick}
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Settings className="size-4" />
              </div>
              <span>{t.app.components.appSidebar.manageWorkspaces}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function SidebarSyncButton({ status, detail, onSync }: SidebarSyncAction) {
  const isSyncing = status === 'syncing';

  return (
    <div className="mx-2 mb-1 flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-full justify-start gap-2 px-2 text-xs"
        onClick={onSync}
        disabled={isSyncing}
      >
        {status === 'error' ? (
          <TriangleAlert className="size-3.5 text-destructive" />
        ) : (
          <RefreshCw className={cn('size-3.5', isSyncing && 'animate-spin')} />
        )}
        <span>{t.app.github.syncButton}</span>
      </Button>
      {detail && (
        <span
          className={cn(
            'px-1 text-[11px] leading-tight',
            status === 'error' ? 'text-destructive' : 'text-foreground/60',
          )}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

function SidebarCollectionGroup({
  label,
  items,
  onAdd,
  addLabel,
}: SidebarCollection) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = React.useState(true);

  if (items.length === 0 && !onAdd) {
    return null;
  }

  return (
    // No vertical padding: these headings sit above the file tree, which has
    // a minimum height the app guarantees, so every pixel here is taken from
    // the tree.
    <SidebarGroup className="py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-1 pr-1">
          <CollapsibleTrigger
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              'h-6 min-w-0 flex-1 justify-start gap-1 px-1 text-[11px] uppercase tracking-wide',
            )}
          >
            {open ? (
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            ) : (
              <ChevronRight className="size-3 shrink-0 opacity-50" />
            )}
            <span className="truncate font-medium opacity-60">{label}</span>
          </CollapsibleTrigger>
          {onAdd && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 opacity-60 hover:opacity-100"
              title={addLabel}
              aria-label={addLabel}
              onClick={() => onAdd()}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          {items.length > 0 && (
            <SidebarMenu className="gap-0.5">
              {items.map((item) => {
                const Icon = resolveCollectionIcon(item.icon);
                const colorClass = item.color
                  ? (TYPE_COLORS[item.color.toLowerCase()] ?? '')
                  : '';
                return (
                  <SidebarMenuItem key={item.key} className="min-w-0">
                    <SidebarMenuButton
                      isActive={item.isActive}
                      className="h-7"
                      onClick={() => {
                        item.onSelect();
                        if (isMobile) {
                          setOpenMobile(false);
                        }
                      }}
                    >
                      <Icon className={cn('size-3.5 shrink-0', colorClass)} />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {item.label}
                      </span>
                      {item.count > 0 && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums opacity-70">
                          {item.count}
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

/**
 * Icon names come from the vault, written for whichever app created it —
 * Tolaria's files use Phosphor names like `stack` and `hands-praying` while
 * this app ships Lucide. Rather than demand the vault change, map the names
 * actually seen in the wild and fall back to a neutral icon, so an
 * unrecognized name costs an icon and never a broken sidebar.
 */
const COLLECTION_ICONS: Record<string, React.ElementType> = {
  'book-open-text': BookOpenText,
  'file-text': FileText,
  files: Files,
  funnel: Filter,
  'hands-praying': Sparkles,
  lightbulb: Lightbulb,
  list: List,
  notebook: NotebookPen,
  'push-pin': Star,
  sparkle: Sparkles,
  stack: Layers,
  tag: Tag,
  user: Sparkles,
};

function resolveCollectionIcon(name: string | undefined): React.ElementType {
  if (!name) {
    return Filter;
  }
  return COLLECTION_ICONS[name.toLowerCase()] ?? Filter;
}

/**
 * Tailwind cannot see class names built at runtime, so the colours a vault
 * may name are listed literally here. Anything else inherits the default.
 */
const TYPE_COLORS: Record<string, string> = {
  blue: 'text-blue-500',
  gray: 'text-gray-500',
  green: 'text-green-500',
  orange: 'text-orange-500',
  pink: 'text-pink-500',
  purple: 'text-purple-500',
  red: 'text-red-500',
  yellow: 'text-yellow-500',
};
