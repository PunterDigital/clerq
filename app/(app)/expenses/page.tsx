import { Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ExpenseTagChip, tagToneClasses } from "@/components/expense-tag-chip";
import { SearchBar } from "@/components/search-bar";
import { ExpenseStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate, formatMoney } from "@/lib/format";
import { isReceiptScanConfigured } from "@/modules/expenses/ocr";
import { caller } from "@/server/trpc/server";

import { DownloadReceipts } from "./download-receipts";

export const metadata: Metadata = {
  title: "Expenses - Clerq",
};

export const dynamic = "force-dynamic";

const filters = [
  { key: "all", label: "All", status: undefined },
  { key: "unpaid", label: "Unpaid", status: "unpaid" },
  { key: "paid", label: "Paid", status: "paid" },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The list's URL: status, search and the selected tags (one `tag` param
// each), so every filter survives a reload and composes with the others.
function expensesHref(opts: {
  status?: string;
  search?: string;
  tagIds: string[];
}) {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.search) params.set("q", opts.search);
  for (const id of opts.tagIds) params.append("tag", id);
  const query = params.toString();
  return query ? `/expenses?${query}` : "/expenses";
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; tag?: string | string[] }>;
}) {
  const { status, q, tag } = await searchParams;
  const active = status === "unpaid" || status === "paid" ? status : undefined;
  const search = q?.trim() || undefined;
  const { tags: allTags } = await caller.expenses.tags.list();
  // Only this business's tags count; a stale or foreign id in the URL is
  // dropped rather than filtering everything out.
  const known = new Set(allTags.map((t) => t.id));
  const tagIds = [
    ...new Set((Array.isArray(tag) ? tag : tag ? [tag] : []).filter((id) => UUID.test(id))),
  ].filter((id) => known.has(id));
  const expenses = await caller.expenses.list({
    status: active,
    search,
    tagIds: tagIds.length > 0 ? tagIds : undefined,
  });
  const selectedTags = allTags.filter((t) => tagIds.includes(t.id));

  // With nothing recorded and no filter or search, this is a first-run
  // business: show the onboarding empty state instead of the search UI.
  const isEmptyBusiness =
    expenses.length === 0 && !active && !search && tagIds.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <h1 className="flex-1 text-2xl">Expenses</h1>
        {!isEmptyBusiness && (
          <Button variant="outline" asChild>
            <Link href="/expenses/tags">Tags</Link>
          </Button>
        )}
        {!isEmptyBusiness && <DownloadReceipts />}
        {/* Bulk upload reads every file with AI, so it needs scanning set up. */}
        {isReceiptScanConfigured() ? (
          <Button variant="outline" asChild>
            <Link href="/expenses/bulk">Bulk upload</Link>
          </Button>
        ) : null}
        <Button asChild>
          <Link href="/expenses/new">New expense</Link>
        </Button>
      </div>

      {isEmptyBusiness ? (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border bg-card px-8 py-12 text-center shadow-sm">
          <span className="mb-2.5 flex size-12 items-center justify-center rounded-full bg-[var(--primary-subtle)] text-[var(--primary-subtle-fg)]">
            <Wallet className="size-[26px]" aria-hidden />
          </span>
          <h2 className="text-lg font-semibold">No expenses yet</h2>
          <p className="max-w-[40ch] text-sm text-muted-foreground">
            Record what your business spends - upload a receipt or enter the
            details by hand, then track each as paid or unpaid.
          </p>
          <div className="mt-3.5">
            <Button asChild>
              <Link href="/expenses/new">Add your first expense</Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1.5">
              {filters.map((f) => {
                const isActive = (active ?? "all") === f.key;
                return (
                  <Link
                    key={f.key}
                    href={expensesHref({ status: f.status, search, tagIds })}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      isActive &&
                        "bg-[var(--primary-subtle)] font-semibold text-[var(--primary-subtle-fg)] hover:bg-[var(--primary-subtle)]",
                    )}
                  >
                    {f.label}
                  </Link>
                );
              })}
            </div>
            <SearchBar
              placeholder="Search expenses"
              className="w-full max-w-sm sm:ml-auto sm:w-auto sm:min-w-64"
            />
          </div>

          {allTags.length > 0 ? (
            <nav
              aria-label="Filter by tag"
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="mr-1 text-sm text-muted-foreground">Tags</span>
              {allTags.map((t) => {
                const on = tagIds.includes(t.id);
                const next = on
                  ? tagIds.filter((id) => id !== t.id)
                  : [...tagIds, t.id];
                return (
                  <Link
                    key={t.id}
                    href={expensesHref({ status: active, search, tagIds: next })}
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
                      on
                        ? cn("border-transparent", tagToneClasses[t.color])
                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {t.name}
                  </Link>
                );
              })}
              {tagIds.length > 0 ? (
                <Link
                  href={expensesHref({ status: active, search, tagIds: [] })}
                  className="ml-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Clear tags
                </Link>
              ) : null}
            </nav>
          ) : null}

          {expenses.length === 0 ? (
            <div className="rounded-lg border bg-card px-8 py-12 text-center text-sm text-muted-foreground shadow-sm">
              {search
                ? `No expenses match "${search}"`
                : selectedTags.length > 0
                  ? `No ${active ? `${active} ` : ""}expenses tagged ${selectedTags.map((t) => t.name).join(" or ")}`
                  : `No ${active} expenses`}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
              {expenses.map((expense) => (
                <Link
                  key={expense.id}
                  href={`/expenses/${expense.id}`}
                  className="flex items-center gap-4 border-b px-4 py-[13px] transition-colors last:border-b-0 hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {expense.description}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {[
                        formatDate(expense.incurredAt),
                        expense.vendor,
                        expense.category,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  {expense.tags.length > 0 ? (
                    <div className="hidden max-w-64 flex-wrap justify-end gap-1 sm:flex">
                      {expense.tags.map((t) => (
                        <ExpenseTagChip key={t.id} name={t.name} color={t.color} />
                      ))}
                    </div>
                  ) : null}
                  <ExpenseStatusPill status={expense.status} />
                  <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums">
                    {formatMoney(expense.amountMinor, expense.currency)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
