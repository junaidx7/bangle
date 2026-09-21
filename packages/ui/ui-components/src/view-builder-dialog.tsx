import {
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@bangle.io/base-ui';
import type { FilterGroup, FilterNode, FilterOp } from '@bangle.io/note-meta';
import { REGEX_OPS, VALUELESS_OPS } from '@bangle.io/note-meta';
import { Plus, Regex, X } from 'lucide-react';
import React, { useId, useState } from 'react';

/** Operator labels, in the order the picker shows them. */
const OPERATORS: ReadonlyArray<{ op: FilterOp; label: string }> = [
  { op: 'equals', label: 'equals' },
  { op: 'not_equals', label: 'does not equal' },
  { op: 'contains', label: 'contains' },
  { op: 'not_contains', label: 'does not contain' },
  { op: 'is_empty', label: 'is empty' },
  { op: 'is_not_empty', label: 'is not empty' },
  { op: 'before', label: 'before' },
  { op: 'after', label: 'after' },
];

/**
 * Editable rows mirror the saved shape but carry an id, so React can keep
 * inputs stable while rows are added and removed around them.
 */
type DraftCondition = {
  id: string;
  kind: 'condition';
  field: string;
  op: FilterOp;
  value: string;
  regex: boolean;
};

type DraftGroup = {
  id: string;
  kind: 'group';
  combinator: 'all' | 'any';
  nodes: DraftNode[];
};

type DraftNode = DraftCondition | DraftGroup;

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `f${nextId}`;
}

function newCondition(field: string): DraftCondition {
  return {
    id: makeId(),
    kind: 'condition',
    field,
    op: 'equals',
    value: '',
    regex: false,
  };
}

function toFilterNode(node: DraftNode): FilterNode {
  if (node.kind === 'group') {
    return {
      combinator: node.combinator,
      nodes: node.nodes.map((child) => toFilterNode(child)),
    };
  }
  return {
    field: node.field.trim(),
    op: node.op,
    value: VALUELESS_OPS.has(node.op) ? undefined : node.value,
    regex: node.regex && REGEX_OPS.has(node.op),
  };
}

export interface ViewBuilderResult {
  name: string;
  filters: FilterGroup;
}

export interface ViewBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Field names to suggest: built-ins plus keys seen in this workspace. */
  fields: readonly string[];
  onCreate: (result: ViewBuilderResult) => void | Promise<void>;
  /** Rejects duplicates before the file is written. */
  validateName?: (name: string) => string | undefined;
}

export function ViewBuilderDialog({
  open,
  onOpenChange,
  fields,
  onCreate,
  validateName,
}: ViewBuilderDialogProps) {
  const defaultField = fields[0] ?? 'type';
  const [name, setName] = useState('');
  const [combinator, setCombinator] = useState<'all' | 'any'>('all');
  const [nodes, setNodes] = useState<DraftNode[]>(() => [
    newCondition(defaultField),
  ]);
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const nameId = useId();
  const listId = useId();

  // Reopening starts clean rather than resuming a half-built filter the user
  // already walked away from.
  React.useEffect(() => {
    if (open) {
      setName('');
      setCombinator('all');
      setNodes([newCondition(defaultField)]);
      setError(undefined);
      setSubmitting(false);
    }
  }, [open, defaultField]);

  const updateNode = (id: string, patch: Partial<DraftCondition>) => {
    const walk = (list: DraftNode[]): DraftNode[] =>
      list.map((node) => {
        if (node.kind === 'group') {
          return { ...node, nodes: walk(node.nodes) };
        }
        return node.id === id ? { ...node, ...patch } : node;
      });
    setNodes((current) => walk(current));
  };

  const removeNode = (id: string) => {
    const walk = (list: DraftNode[]): DraftNode[] =>
      list
        .filter((node) => node.id !== id)
        .map((node) =>
          node.kind === 'group' ? { ...node, nodes: walk(node.nodes) } : node,
        );
    setNodes((current) => walk(current));
  };

  const setGroupCombinator = (id: string, next: 'all' | 'any') => {
    const walk = (list: DraftNode[]): DraftNode[] =>
      list.map((node) =>
        node.kind === 'group'
          ? {
              ...node,
              combinator: node.id === id ? next : node.combinator,
              nodes: walk(node.nodes),
            }
          : node,
      );
    setNodes((current) => walk(current));
  };

  const addToGroup = (id: string | undefined, node: DraftNode) => {
    if (!id) {
      setNodes((current) => [...current, node]);
      return;
    }
    const walk = (list: DraftNode[]): DraftNode[] =>
      list.map((child) =>
        child.kind === 'group'
          ? {
              ...child,
              nodes:
                child.id === id ? [...child.nodes, node] : walk(child.nodes),
            }
          : child,
      );
    setNodes((current) => walk(current));
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.app.dialogs.createView.nameRequired);
      return;
    }
    const nameError = validateName?.(trimmed);
    if (nameError) {
      setError(nameError);
      return;
    }
    // An incomplete row would silently match nothing, so it is rejected
    // rather than saved as a view that looks broken.
    const incomplete = (list: DraftNode[]): boolean =>
      list.some((node) =>
        node.kind === 'group'
          ? incomplete(node.nodes)
          : !node.field.trim() ||
            (!VALUELESS_OPS.has(node.op) && !node.value.trim()),
      );
    if (incomplete(nodes)) {
      setError(t.app.dialogs.createView.incompleteFilter);
      return;
    }

    setSubmitting(true);
    try {
      await onCreate({
        name: trimmed,
        filters: {
          combinator,
          nodes: nodes.map((node) => toFilterNode(node)),
        },
      });
    } catch (submissionError) {
      setSubmitting(false);
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : String(submissionError),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.app.dialogs.createView.title}</DialogTitle>
          <DialogDescription>
            {t.app.dialogs.createView.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={nameId}>{t.app.dialogs.createView.inputLabel}</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            placeholder={t.app.dialogs.createView.placeholder}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label>{t.app.dialogs.createView.filtersLabel}</Label>
          <CombinatorToggle
            value={combinator}
            onChange={setCombinator}
            className="mb-1"
          />
          <div className="space-y-2">
            {nodes.map((node) =>
              node.kind === 'group' ? (
                <GroupRow
                  key={node.id}
                  group={node}
                  listId={listId}
                  onChangeCombinator={setGroupCombinator}
                  onUpdate={updateNode}
                  onRemove={removeNode}
                  onAdd={addToGroup}
                  defaultField={defaultField}
                />
              ) : (
                <ConditionRow
                  key={node.id}
                  condition={node}
                  listId={listId}
                  onUpdate={updateNode}
                  onRemove={removeNode}
                />
              ),
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <AddButton
              label={t.app.dialogs.createView.addFilter}
              onClick={() => addToGroup(undefined, newCondition(defaultField))}
            />
            <AddButton
              label={t.app.dialogs.createView.addGroup}
              onClick={() =>
                addToGroup(undefined, {
                  id: makeId(),
                  kind: 'group',
                  combinator: 'any',
                  nodes: [newCondition(defaultField)],
                })
              }
            />
          </div>
        </div>

        {error && (
          <div
            className="rounded-sm bg-destructive p-2 text-destructive-foreground text-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t.app.common.cancelButton}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={submitting}>
            {t.app.dialogs.createView.submitText}
          </Button>
        </DialogFooter>

        <datalist id={listId}>
          {fields.map((field) => (
            <option key={field} value={field} />
          ))}
        </datalist>
      </DialogContent>
    </Dialog>
  );
}

function CombinatorToggle({
  value,
  onChange,
  className,
}: {
  value: 'all' | 'any';
  onChange: (next: 'all' | 'any') => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 font-medium text-xs"
        onClick={() => onChange(value === 'all' ? 'any' : 'all')}
      >
        {value === 'all'
          ? t.app.dialogs.createView.andLabel
          : t.app.dialogs.createView.orLabel}
      </Button>
      <span className="text-foreground/60 text-xs">
        {value === 'all'
          ? t.app.dialogs.createView.matchAll
          : t.app.dialogs.createView.matchAny}
      </span>
    </div>
  );
}

function ConditionRow({
  condition,
  listId,
  onUpdate,
  onRemove,
}: {
  condition: DraftCondition;
  listId: string;
  onUpdate: (id: string, patch: Partial<DraftCondition>) => void;
  onRemove: (id: string) => void;
}) {
  const takesValue = !VALUELESS_OPS.has(condition.op);
  const allowsRegex = REGEX_OPS.has(condition.op);

  return (
    // Wraps to stacked rows on a phone rather than overflowing sideways.
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        className="h-9 min-w-0 flex-1 basis-32"
        list={listId}
        value={condition.field}
        onChange={(event) =>
          onUpdate(condition.id, { field: event.target.value })
        }
        placeholder={t.app.dialogs.createView.fieldPlaceholder}
        autoComplete="off"
        spellCheck={false}
      />
      <select
        className={cn(
          'h-9 min-w-0 basis-36 rounded-lg border border-input bg-transparent px-2 text-sm',
        )}
        value={condition.op}
        onChange={(event) =>
          onUpdate(condition.id, { op: event.target.value as FilterOp })
        }
        aria-label={t.app.dialogs.createView.operatorLabel}
      >
        {OPERATORS.map(({ op, label }) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
      {takesValue && (
        <Input
          className="h-9 min-w-0 flex-1 basis-32"
          value={condition.value}
          onChange={(event) =>
            onUpdate(condition.id, { value: event.target.value })
          }
          placeholder={t.app.dialogs.createView.valuePlaceholder}
          autoComplete="off"
        />
      )}
      {allowsRegex && (
        <Button
          variant={condition.regex ? 'default' : 'outline'}
          size="icon"
          className="h-9 w-9 shrink-0"
          title={t.app.dialogs.createView.regexLabel}
          aria-label={t.app.dialogs.createView.regexLabel}
          aria-pressed={condition.regex}
          onClick={() => onUpdate(condition.id, { regex: !condition.regex })}
        >
          <Regex className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0"
        title={t.app.dialogs.createView.removeFilter}
        aria-label={t.app.dialogs.createView.removeFilter}
        onClick={() => onRemove(condition.id)}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function GroupRow({
  group,
  listId,
  onChangeCombinator,
  onUpdate,
  onRemove,
  onAdd,
  defaultField,
}: {
  group: DraftGroup;
  listId: string;
  onChangeCombinator: (id: string, next: 'all' | 'any') => void;
  onUpdate: (id: string, patch: Partial<DraftCondition>) => void;
  onRemove: (id: string) => void;
  onAdd: (id: string | undefined, node: DraftNode) => void;
  defaultField: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <CombinatorToggle
          value={group.combinator}
          onChange={(next) => onChangeCombinator(group.id, next)}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t.app.dialogs.createView.removeGroup}
          onClick={() => onRemove(group.id)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="space-y-2">
        {group.nodes.map((node) =>
          node.kind === 'condition' ? (
            <ConditionRow
              key={node.id}
              condition={node}
              listId={listId}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ) : null,
        )}
      </div>
      <AddButton
        label={t.app.dialogs.createView.addFilter}
        onClick={() => onAdd(group.id, newCondition(defaultField))}
      />
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'h-7 gap-1 px-1.5 text-xs',
      )}
      onClick={onClick}
    >
      <Plus className="size-3.5" />
      {label}
    </button>
  );
}
