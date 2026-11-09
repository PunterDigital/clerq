import { cn } from "@/lib/utils";
import type { TagColor } from "@/modules/expenses/tag-options";

// Expense tag tones (#4395), all from design tokens so they follow light and
// dark mode. Same pill shape as the status pills.
export const tagToneClasses: Record<TagColor, string> = {
  gray: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  teal: "bg-[var(--primary-subtle)] text-[var(--primary-subtle-fg)]",
  blue: "bg-[var(--info-subtle)] text-[var(--info-subtle-fg)]",
  green: "bg-[var(--success-subtle)] text-[var(--success-subtle-fg)]",
  amber: "bg-[var(--warning-subtle)] text-[var(--warning-subtle-fg)]",
  red: "bg-[var(--error-subtle)] text-[var(--error-subtle-fg)]",
};

export const tagColorLabels: Record<TagColor, string> = {
  gray: "Grey",
  teal: "Teal",
  blue: "Blue",
  green: "Green",
  amber: "Amber",
  red: "Red",
};

export function ExpenseTagChip({
  name,
  color,
  className,
}: {
  name: string;
  color: TagColor;
  className?: string;
}) {
  return (
    <span
      data-testid="expense-tag"
      className={cn(
        "inline-flex max-w-40 items-center truncate rounded-full px-2 py-px text-xs font-semibold",
        tagToneClasses[color],
        className,
      )}
    >
      {name}
    </span>
  );
}
