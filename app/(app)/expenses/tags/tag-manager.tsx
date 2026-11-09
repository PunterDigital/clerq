"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
  ExpenseTagChip,
  tagColorLabels,
} from "@/components/expense-tag-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TAG_COLORS, type TagColor } from "@/modules/expenses/tag-options";
import { useTRPC } from "@/server/trpc/client";

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

type Tag = { id: string; name: string; color: TagColor; expenseCount: number };

export function TagManager() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.expenses.tags.list.queryOptions();
  const tags = useQuery(listOptions);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: listOptions.queryKey });

  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("gray");
  const create = useMutation(
    trpc.expenses.tags.create.mutationOptions({
      onSuccess: async () => {
        setName("");
        setColor("gray");
        await refresh();
      },
    }),
  );

  if (tags.isPending) {
    return <p className="text-sm text-muted-foreground">Loading tags...</p>;
  }
  if (tags.error) {
    return <p className="text-sm text-destructive">{tags.error.message}</p>;
  }
  const { canManage, canCreate } = tags.data;

  return (
    <div className="flex flex-col gap-6">
      {canCreate ? (
        <Card>
          <CardContent className="pt-6">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) create.mutate({ name: name.trim(), color });
              }}
            >
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <Label htmlFor="new-tag-name">New tag</Label>
                <Input
                  id="new-tag-name"
                  maxLength={50}
                  placeholder="Client A"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-tag-color">Colour</Label>
                <select
                  id="new-tag-color"
                  className={selectClass}
                  value={color}
                  onChange={(e) => setColor(e.target.value as TagColor)}
                >
                  {TAG_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {tagColorLabels[c]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                Create tag
              </Button>
            </form>
            {create.error ? (
              <p className="mt-3 text-sm text-destructive">{create.error.message}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {tags.data.tags.length === 0 ? (
        <div className="rounded-lg border bg-card px-8 py-12 text-center text-sm text-muted-foreground shadow-sm">
          No tags yet. Create one here, or add it while you record an expense.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          {tags.data.tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} canManage={canManage} onChanged={refresh} />
          ))}
        </div>
      )}

      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Renaming, recolouring and deleting tags is up to an owner or admin.
        </p>
      ) : null}
    </div>
  );
}

function TagRow({
  tag,
  canManage,
  onChanged,
}: {
  tag: Tag;
  canManage: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<TagColor>(tag.color);

  const update = useMutation(
    trpc.expenses.tags.update.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await onChanged();
      },
    }),
  );
  const remove = useMutation(
    trpc.expenses.tags.delete.mutationOptions({ onSuccess: () => onChanged() }),
  );

  const count = `${tag.expenseCount} expense${tag.expenseCount === 1 ? "" : "s"}`;

  if (editing) {
    return (
      <form
        data-testid="tag-row"
        className="flex flex-wrap items-center gap-2 border-b px-4 py-3 last:border-b-0"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ tagId: tag.id, data: { name: name.trim(), color } });
        }}
      >
        <Input
          aria-label="Tag name"
          maxLength={50}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-56 flex-1"
          autoFocus
        />
        <select
          aria-label="Tag colour"
          className={selectClass}
          value={color}
          onChange={(e) => setColor(e.target.value as TagColor)}
        >
          {TAG_COLORS.map((c) => (
            <option key={c} value={c}>
              {tagColorLabels[c]}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={!name.trim() || update.isPending}>
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setName(tag.name);
            setColor(tag.color);
            update.reset();
          }}
        >
          Cancel
        </Button>
        {update.error ? (
          <p className="w-full text-sm text-destructive">{update.error.message}</p>
        ) : null}
      </form>
    );
  }

  return (
    <div
      data-testid="tag-row"
      className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
    >
      <ExpenseTagChip name={tag.name} color={tag.color} />
      <Link
        href={`/expenses?tag=${tag.id}`}
        className="flex-1 text-sm text-muted-foreground hover:text-foreground"
      >
        {count}
      </Link>
      {canManage ? (
        confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">
              Delete &quot;{tag.name}&quot;? It comes off {count}.
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ tagId: tag.id })}
            >
              Delete tag
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </div>
        )
      ) : null}
      {remove.error ? (
        <p className="w-full text-sm text-destructive">{remove.error.message}</p>
      ) : null}
    </div>
  );
}
