import { cn } from "@/lib/utils";

// Status pills per the design system: coloured dot intent via tinted
// background + label, never emoji. Project statuses reuse the invoice
// lifecycle pill tokens with matching semantics (active = in motion,
// on hold = neutral, completed = done).
const styles = {
  active: "bg-[var(--status-sent-bg)] text-[var(--status-sent-fg)]",
  on_hold: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  completed: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
} as const;

const labels = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
} as const;

export type ProjectStatus = keyof typeof styles;

export function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-xs font-semibold",
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}

const taskStyles = {
  todo: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  in_progress: "bg-[var(--status-sent-bg)] text-[var(--status-sent-fg)]",
  in_review: "bg-[var(--warning-subtle)] text-[var(--warning-subtle-fg)]",
  done: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
} as const;

const taskLabels = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
} as const;

export type TaskStatus = keyof typeof taskStyles;

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-xs font-semibold",
        taskStyles[status],
      )}
    >
      {taskLabels[status]}
    </span>
  );
}

// The invoice lifecycle pills these tokens were designed for.
const invoiceStyles = {
  draft: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  sent: "bg-[var(--status-sent-bg)] text-[var(--status-sent-fg)]",
  paid: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
  overdue: "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
  // Voided: muted/struck-through, reusing the neutral draft tokens - a void
  // is a closed-out document, not an active state.
  void: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)] line-through",
  // Credited in full by credit notes (#5042): settled, nothing owed, so it
  // reuses the closed-out paid tokens.
  credited: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
} as const;

const invoiceLabels = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
  credited: "Credited",
} as const;

export type InvoiceStatus = keyof typeof invoiceStyles;

export function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-xs font-semibold",
        invoiceStyles[status],
      )}
    >
      {invoiceLabels[status]}
    </span>
  );
}

// Recurring-invoice schedules: active reuses the in-motion (sent) token,
// paused the neutral draft token, ended the settled/closed token.
const scheduleStyles = {
  active: "bg-[var(--status-sent-bg)] text-[var(--status-sent-fg)]",
  paused: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  ended: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
} as const;

const scheduleLabels = {
  active: "Active",
  paused: "Paused",
  ended: "Ended",
} as const;

export type ScheduleStatus = keyof typeof scheduleStyles;

export function ScheduleStatusPill({ status }: { status: ScheduleStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-xs font-semibold",
        scheduleStyles[status],
      )}
    >
      {scheduleLabels[status]}
    </span>
  );
}

// Expenses: paid reuses the settled (green) token; unpaid uses the warning
// tint so an outstanding cost reads as actionable, not merely neutral.
const expenseStyles = {
  unpaid: "bg-[var(--warning-subtle)] text-[var(--warning-subtle-fg)]",
  paid: "bg-[var(--status-paid-bg)] text-[var(--status-paid-fg)]",
} as const;

const expenseLabels = {
  unpaid: "Unpaid",
  paid: "Paid",
} as const;

export type ExpenseStatus = keyof typeof expenseStyles;

export function ExpenseStatusPill({ status }: { status: ExpenseStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-xs font-semibold",
        expenseStyles[status],
      )}
    >
      {expenseLabels[status]}
    </span>
  );
}
