"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { TaskStatusPill, type TaskStatus } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatClock,
  formatDate,
  formatHoursClock,
  formatMinutes,
  formatRate,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/server/trpc/client";

export type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  estimateMinutes: number | null;
  trackedSeconds: number;
};

const COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "in_progress", title: "In progress" },
  { id: "in_review", title: "In review" },
  { id: "done", title: "Done" },
];

const selectClassName =
  "h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

const noteTextareaClassName =
  "w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

function estimateToMinutes(hoursText: string): number | null {
  if (!hoursText.trim()) {
    return null;
  }
  const hours = Number(hoursText);
  if (!Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  return Math.round(hours * 60);
}

export function TasksPanel({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: TaskRow[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [view, setView] = useState<"board" | "list">("board");
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);

  const queryClient = useQueryClient();
  const refresh = () => router.refresh();
  const refreshTimer = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.time.running.queryKey(),
    });
    refresh();
  };
  const running = useQuery(trpc.time.running.queryOptions());
  const startTimer = useMutation(
    trpc.time.start.mutationOptions({ onSuccess: refreshTimer }),
  );
  const stopTimer = useMutation(
    trpc.time.stop.mutationOptions({ onSuccess: refreshTimer }),
  );
  const create = useMutation(
    trpc.tasks.create.mutationOptions({ onSuccess: refresh }),
  );
  const move = useMutation(
    trpc.tasks.setStatus.mutationOptions({ onSuccess: refresh }),
  );
  const update = useMutation(
    trpc.tasks.update.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        refresh();
      },
    }),
  );
  const remove = useMutation(
    trpc.tasks.delete.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        // Deleting a task cascades to its time entries, so a running timer
        // on it is gone too - refresh the timer state alongside the board.
        void refreshTimer();
      },
    }),
  );

  function onDrop(status: TaskStatus) {
    if (dragId) {
      const current = tasks.find((t) => t.id === dragId);
      if (current && current.status !== status) {
        move.mutate({ taskId: dragId, status });
      }
    }
    setDragId(null);
    setDropTarget(null);
  }

  const dragged = dragId ? tasks.find((t) => t.id === dragId) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">Tasks</h2>
        <div className="flex rounded-md border p-0.5">
          {(["board", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-sm font-medium capitalize text-muted-foreground transition-colors",
                view === mode && "bg-muted text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {view === "board" ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => {
            const columnTasks = tasks.filter((t) => t.status === column.id);
            const isDropTarget =
              dropTarget === column.id && dragged && dragged.status !== column.id;
            return (
              <div
                key={column.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget(column.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDropTarget((prev) =>
                      prev === column.id ? null : prev,
                    );
                  }
                }}
                onDrop={() => onDrop(column.id)}
                className={cn(
                  "flex min-h-[120px] flex-col gap-2.5 rounded-lg bg-[var(--surface-sunken)] p-2.5 transition-colors",
                  isDropTarget &&
                    "bg-[var(--primary-subtle)] ring-2 ring-inset ring-[var(--primary-border)]",
                )}
              >
                <div className="flex items-center gap-2 px-1 pt-0.5">
                  <span className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                    {column.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {columnTasks.length}
                  </span>
                </div>
                {columnTasks.map((task) => {
                  const isRunning = running.data?.taskId === task.id;
                  return (
                    <div
                      key={task.id}
                      draggable
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditing(task)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditing(task);
                        }
                      }}
                      onDragStart={() => setDragId(task.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropTarget(null);
                      }}
                      className={cn(
                        "flex cursor-pointer flex-col gap-1.5 rounded-md border bg-card p-3 shadow-xs transition-shadow hover:shadow-sm active:cursor-grabbing",
                        isRunning && "border-[var(--primary-border)]",
                        dragId === task.id && "opacity-50",
                      )}
                    >
                      <span className="text-left text-sm font-medium">
                        {task.title}
                      </span>
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs text-muted-foreground tabular"
                          title="Tracked time"
                        >
                          {formatHoursClock(task.trackedSeconds)}
                        </span>
                        {task.estimateMinutes ? (
                          <span className="text-xs text-muted-foreground/70 tabular">
                            of {formatMinutes(task.estimateMinutes)}
                          </span>
                        ) : null}
                        <span className="flex-1" />
                        {isRunning && running.data ? (
                          <RunningClock startedAt={running.data.startedAt} />
                        ) : null}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={
                            isRunning ? "Stop timer" : "Start timer on this task"
                          }
                          disabled={startTimer.isPending || stopTimer.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isRunning) {
                              stopTimer.mutate();
                            } else {
                              startTimer.mutate({ taskId: task.id });
                            }
                          }}
                          className={cn(
                            "size-6 rounded-full",
                            isRunning && "text-[var(--primary-subtle-fg)]",
                          )}
                        >
                          {isRunning ? (
                            <Square className="size-3 fill-current" aria-hidden />
                          ) : (
                            <Play className="size-3.5" aria-hidden />
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {isDropTarget && dragged ? (
                  <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-[var(--primary-border)] bg-card/60 p-3">
                    <span className="text-sm font-medium text-muted-foreground">
                      {dragged.title}
                    </span>
                  </div>
                ) : null}
                <QuickAdd
                  pending={create.isPending}
                  onAdd={(title) =>
                    create.mutate({
                      projectId,
                      data: { title, status: column.id },
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          {tasks.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No tasks yet - add one on the board
            </p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setEditing(task)}
                className="flex w-full items-center gap-4 border-b px-4 py-[13px] text-left transition-colors last:border-b-0 hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {task.title}
                </span>
                <span
                  className="shrink-0 text-sm text-muted-foreground tabular"
                  title="Tracked time"
                >
                  {formatHoursClock(task.trackedSeconds)}
                </span>
                {task.estimateMinutes ? (
                  <span className="shrink-0 text-sm text-muted-foreground/70 tabular">
                    of {formatMinutes(task.estimateMinutes)}
                  </span>
                ) : null}
                <TaskStatusPill status={task.status} />
              </button>
            ))
          )}
        </div>
      )}

      {editing ? (
        <EditTaskDialog
          task={editing}
          onClose={() => setEditing(null)}
          onSave={(data) => update.mutate({ taskId: editing.id, data })}
          onDelete={() => remove.mutate({ taskId: editing.id })}
          saving={update.isPending}
          deleting={remove.isPending}
          error={update.error?.message ?? remove.error?.message ?? null}
        />
      ) : null}
    </div>
  );
}

function RunningClock({ startedAt }: { startedAt: Date | string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  return (
    <span className="font-mono text-xs font-semibold text-[var(--primary-subtle-fg)] tabular">
      {formatClock(elapsed)}
    </span>
  );
}

function QuickAdd({
  onAdd,
  pending,
}: {
  onAdd: (title: string) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) {
          onAdd(title.trim());
          setTitle("");
        }
      }}
    >
      <Input
        aria-label="Add a task"
        placeholder="+ Add a task"
        disabled={pending}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="h-8 cursor-pointer border-transparent bg-transparent shadow-none transition-colors placeholder:text-muted-foreground/70 hover:border-border hover:bg-card hover:placeholder:text-muted-foreground focus-visible:cursor-text focus-visible:border-ring focus-visible:bg-card"
      />
    </form>
  );
}

function EditTaskDialog({
  task,
  onClose,
  onSave,
  onDelete,
  saving,
  deleting,
  error,
}: {
  task: TaskRow;
  onClose: () => void;
  onSave: (data: {
    title: string;
    status: TaskStatus;
    estimateMinutes: number | null;
  }) => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
  error: string | null;
}) {
  const [title, setTitle] = useState(task.title);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [estimate, setEstimate] = useState(
    task.estimateMinutes ? String(task.estimateMinutes / 60) : "",
  );
  // Deleting a task also deletes its tracked time, so gate it behind a
  // confirm step (matches the invoice draft/void delete pattern).
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Wider than the dialog default (sm:max-w-sm) - the editor has
          side-by-side fields and the time log row, which overflowed */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              title,
              status,
              estimateMinutes: estimateToMinutes(estimate),
            });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="task-status">Status</Label>
              <select
                id="task-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
                className={selectClassName}
              >
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="task-estimate">Estimate (hours)</Label>
              <Input
                id="task-estimate"
                type="number"
                min="0"
                step="0.25"
                placeholder="2.5"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
              />
            </div>
          </div>
          {confirmingDelete ? (
            <div className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Delete this task?</p>
                <p className="text-sm text-muted-foreground">
                  This permanently deletes{" "}
                  <span className="font-medium text-foreground">
                    {task.title}
                  </span>{" "}
                  and every time entry logged against it
                  {task.trackedSeconds > 0
                    ? ` (${formatHoursClock(task.trackedSeconds)} tracked)`
                    : ""}
                  . This cannot be undone. Time already billed on an invoice
                  blocks deletion until it is released.
                </p>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleting}
                  onClick={onDelete}
                >
                  {deleting ? "Deleting..." : "Delete task and time"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(true)}
                  className="text-destructive hover:text-destructive"
                >
                  Delete
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
        <TimeSection taskId={task.id} />
      </DialogContent>
    </Dialog>
  );
}

function TimeSection({ taskId }: { taskId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const entries = useQuery(trpc.time.listForTask.queryOptions({ taskId }));
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.time.listForTask.queryKey({ taskId }),
    });
  const log = useMutation(
    trpc.time.logManual.mutationOptions({ onSuccess: invalidate }),
  );
  const remove = useMutation(
    trpc.time.deleteEntry.mutationOptions({ onSuccess: invalidate }),
  );
  const saveNote = useMutation(
    trpc.time.updateNote.mutationOptions({
      onSuccess: () => {
        setNoteDraft(null);
        invalidate();
      },
    }),
  );

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState("");
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState("");
  const [noteDraft, setNoteDraft] = useState<{
    entryId: string;
    text: string;
  } | null>(null);

  const closed = (entries.data ?? []).filter((e) => e.durationSeconds !== null);
  const totalSeconds = closed.reduce(
    (sum, e) => sum + (e.durationSeconds ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">Tracked time</h3>
        {totalSeconds > 0 ? (
          <span className="text-xs text-muted-foreground tabular">
            {formatMinutes(Math.round(totalSeconds / 60))} total
          </span>
        ) : null}
      </div>

      {closed.length > 0 ? (
        <ul className="flex max-h-48 flex-col overflow-y-auto">
          {closed.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-1 border-b py-1.5 text-sm last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {formatDate(new Date(entry.startedAt))}
                </span>
                <span className="font-medium tabular">
                  {formatMinutes(Math.round((entry.durationSeconds ?? 0) / 60))}
                </span>
                {entry.rateMinor != null && entry.rateCurrency ? (
                  <span className="text-xs text-muted-foreground tabular">
                    {formatRate(entry.rateMinor, entry.rateCurrency)}
                  </span>
                ) : null}
                {!entry.billable ? (
                  <span className="rounded-full bg-[var(--status-draft-bg)] px-1.5 text-xs font-semibold text-[var(--status-draft-fg)]">
                    Non-billable
                  </span>
                ) : null}
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saveNote.isPending}
                  onClick={() =>
                    setNoteDraft(
                      noteDraft?.entryId === entry.id
                        ? null
                        : { entryId: entry.id, text: entry.note ?? "" },
                    )
                  }
                  className="h-6 px-2 text-xs"
                >
                  {entry.note ? "Edit note" : "Add note"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete entry"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ entryId: entry.id })}
                  className="size-6"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              {noteDraft?.entryId === entry.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveNote.mutate({
                      entryId: entry.id,
                      note: noteDraft.text.trim() || null,
                    });
                  }}
                  className="flex flex-col items-end gap-2"
                >
                  <textarea
                    aria-label="Entry note"
                    autoFocus
                    rows={3}
                    placeholder="What happened during this time - one item per line if you like"
                    value={noteDraft.text}
                    onChange={(e) =>
                      setNoteDraft({ entryId: entry.id, text: e.target.value })
                    }
                    className={noteTextareaClassName}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={saveNote.isPending}
                    className="h-7"
                  >
                    Save
                  </Button>
                </form>
              ) : entry.note ? (
                <p className="whitespace-pre-line text-xs text-muted-foreground">
                  {entry.note}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No time tracked yet</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const h = Number(hours);
          if (Number.isFinite(h) && h > 0) {
            log.mutate({
              taskId,
              startedAt: new Date(`${date}T09:00:00.000Z`),
              durationSeconds: Math.round(h * 3600),
              billable,
              note: note.trim() || undefined,
            });
            setHours("");
            setNote("");
          }
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="log-date" className="text-xs">
              Date
            </Label>
            <Input
              id="log-date"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="flex w-20 flex-col gap-1.5">
            <Label htmlFor="log-hours" className="text-xs">
              Hours
            </Label>
            <Input
              id="log-hours"
              type="number"
              min="0"
              step="any"
              required
              placeholder="1.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="h-8"
            />
          </div>
          <label className="flex h-8 items-center gap-1.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
            />
            Billable
          </label>
          <Button type="submit" size="sm" disabled={log.isPending}>
            {log.isPending ? "Logging..." : "Log time"}
          </Button>
        </div>
        <textarea
          aria-label="Note for this entry"
          rows={3}
          placeholder="Optional note - what this time covered. Use a new line for each thing you did."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={noteTextareaClassName}
        />
      </form>
      {log.error ? (
        <p role="alert" className="text-sm text-destructive">
          {log.error.message}
        </p>
      ) : null}
      {remove.error ? (
        <p role="alert" className="text-sm text-destructive">
          {remove.error.message}
        </p>
      ) : null}
    </div>
  );
}
