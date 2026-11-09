// Expense tag constants with no database imports, so client components can
// use them (#4395). The service in ./tags re-exports these.

// The tones a tag can take. Each maps onto design-system tokens (see
// components/expense-tag-chip.tsx), so tags follow light and dark mode and
// never carry a free-form colour.
export const TAG_COLORS = ["gray", "teal", "blue", "green", "amber", "red"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const MAX_TAGS_PER_EXPENSE = 20;
