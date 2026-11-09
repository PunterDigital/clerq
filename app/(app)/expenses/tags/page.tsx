import type { Metadata } from "next";
import Link from "next/link";

import { TagManager } from "./tag-manager";

export const metadata: Metadata = {
  title: "Expense tags - Clerq",
};

export const dynamic = "force-dynamic";

export default function ExpenseTagsPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/expenses"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Expenses
        </Link>
        <h1 className="text-2xl">Expense tags</h1>
        <p className="text-sm text-muted-foreground">
          Group expenses by client, trip or anything else, then filter the
          expense list by tag. Deleting a tag takes it off its expenses; the
          expenses stay.
        </p>
      </div>
      <TagManager />
    </div>
  );
}
