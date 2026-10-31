import { dateField } from "./v1";

export const SCHEDULE_STATUSES = ["active", "paused", "ended"] as const;

// Turns a schedule body's date fields into Dates.
export function recurringDateFields(body: Record<string, unknown>): void {
  dateField(body, "startDate");
  dateField(body, "endDate");
}
