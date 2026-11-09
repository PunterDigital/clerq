"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { useState } from "react";

import { tagToneClasses } from "@/components/expense-tag-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { MAX_TAGS_PER_EXPENSE } from "@/modules/expenses/tag-options";
import { useTRPC } from "@/server/trpc/client";

// The expense form's tag field (#4395): every tag as a toggle, plus "new
// tag" inline for anyone who can create one. Selection is owned by the form.
export function TagPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.expenses.tags.list.queryOptions();
  const tags = useQuery(listOptions);
  const [newName, setNewName] = useState("");

  const create = useMutation(
    trpc.expenses.tags.create.mutationOptions({
      onSuccess: async (tag) => {
        setNewName("");
        await queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
        if (!value.includes(tag.id)) onChange([...value, tag.id]);
      },
    }),
  );

  const all = tags.data?.tags ?? [];
  const full = value.length >= MAX_TAGS_PER_EXPENSE;

  function toggle(tagId: string) {
    if (value.includes(tagId)) {
      onChange(value.filter((id) => id !== tagId));
    } else if (!full) {
      onChange([...value, tagId]);
    }
  }

  function addNew() {
    const name = newName.trim();
    if (!name) return;
    // An existing name (ignoring case) is selected instead of duplicated.
    const existing = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      setNewName("");
      if (!value.includes(existing.id) && !full) onChange([...value, existing.id]);
      return;
    }
    create.mutate({ name, color: "gray" });
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-labelledby="tags-label"
        className="flex flex-wrap gap-1.5"
      >
        {tags.isPending ? (
          <span className="text-sm text-muted-foreground">Loading tags...</span>
        ) : all.length === 0 ? (
          <span className="text-sm text-muted-foreground">No tags yet.</span>
        ) : (
          all.map((tag) => {
            const selected = value.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={selected}
                disabled={!selected && full}
                onClick={() => toggle(tag.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
                  selected
                    ? cn("border-transparent", tagToneClasses[tag.color])
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {selected ? <Check className="size-3" aria-hidden /> : null}
                {tag.name}
              </button>
            );
          })
        )}
      </div>
      {tags.data?.canCreate ? (
        <div className="flex gap-2">
          <Input
            aria-label="New tag name"
            placeholder="New tag"
            maxLength={50}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the tag rather than submitting the whole form.
              if (e.key === "Enter") {
                e.preventDefault();
                addNew();
              }
            }}
            className="max-w-48"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!newName.trim() || create.isPending || full}
            onClick={addNew}
          >
            <Plus aria-hidden />
            Add tag
          </Button>
        </div>
      ) : null}
      {create.error ? (
        <p className="text-sm text-destructive">{create.error.message}</p>
      ) : null}
    </div>
  );
}
