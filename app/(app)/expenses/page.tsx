import { Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

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

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { status, q } = await searchParams;
  const active = status === "unpaid" || status === "paid" ? status : undefined;
  const search = q?.trim() || undefined;
  const expenses = await caller.expenses.list({ status: active, search });

  // With nothing recorded and no filter or search, this is a first-run
  // business: show the onboarding empty state instead of the search UI.
  const isEmptyBusiness = expenses.length === 0 && !active && !search;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <h1 className="flex-1 text-2xl">Expenses</h1>
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
                const params = new URLSearchParams();
                if (f.status) params.set("status", f.status);
                if (search) params.set("q", search);
                const query = params.toString();
                return (
                  <Link
                    key={f.key}
                    href={query ? `/expenses?${query}` : "/expenses"}
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

          {expenses.length === 0 ? (
            <div className="rounded-lg border bg-card px-8 py-12 text-center text-sm text-muted-foreground shadow-sm">
              {search
                ? `No expenses match "${search}"`
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
