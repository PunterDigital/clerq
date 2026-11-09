import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ExpenseTagChip } from "@/components/expense-tag-chip";
import { ExpenseStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateFull, formatDateTime, formatMoney } from "@/lib/format";
import { caller } from "@/server/trpc/server";

import {
  DeleteExpenseButton,
  TogglePaidButton,
} from "./expense-actions";
import { ReceiptLinks } from "./receipt-links";

export const metadata: Metadata = {
  title: "Expense - Clerq",
};

export const dynamic = "force-dynamic";

async function load(expenseId: string) {
  try {
    return await caller.expenses.get({ expenseId });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ expenseId: string }>;
}) {
  const { expenseId } = await params;
  const expense = await load(expenseId);
  const isImage =
    expense.receiptMimeType === "image/png" ||
    expense.receiptMimeType === "image/jpeg";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-2xl">{expense.description}</h1>
            <ExpenseStatusPill status={expense.status} />
          </div>
          <div className="text-3xl font-semibold tabular-nums">
            {formatMoney(expense.amountMinor, expense.currency)}
          </div>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/expenses/${expense.id}/edit`}>Edit</Link>
        </Button>
        <TogglePaidButton expenseId={expense.id} status={expense.status} />
        <DeleteExpenseButton expenseId={expense.id} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
            <dt className="text-muted-foreground">Date incurred</dt>
            <dd>{formatDateFull(expense.incurredAt)}</dd>

            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {expense.status === "paid" && expense.paidAt
                ? `Paid ${formatDateTime(expense.paidAt)}`
                : "Unpaid"}
            </dd>

            {expense.vendor ? (
              <>
                <dt className="text-muted-foreground">Vendor</dt>
                <dd>{expense.vendor}</dd>
              </>
            ) : null}

            {expense.category ? (
              <>
                <dt className="text-muted-foreground">Category</dt>
                <dd>{expense.category}</dd>
              </>
            ) : null}

            {expense.tags.length > 0 ? (
              <>
                <dt className="text-muted-foreground">Tags</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {expense.tags.map((tag) => (
                    <Link
                      key={tag.id}
                      href={`/expenses?tag=${tag.id}`}
                      className="rounded-full focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <ExpenseTagChip name={tag.name} color={tag.color} />
                    </Link>
                  ))}
                </dd>
              </>
            ) : null}

            {expense.notes ? (
              <>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{expense.notes}</dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Receipt</CardTitle>
        </CardHeader>
        <CardContent>
          {expense.receiptDataUrl ? (
            <div className="flex flex-col gap-3">
              {isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={expense.receiptDataUrl}
                  alt={expense.receiptFilename ?? "Receipt"}
                  className="max-h-96 w-auto rounded-md border object-contain"
                />
              ) : (
                <div className="flex h-24 w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
                  {expense.receiptFilename ?? "receipt.pdf"}
                </div>
              )}
              <ReceiptLinks
                dataUrl={expense.receiptDataUrl}
                filename={expense.receiptFilename ?? "receipt"}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No receipt attached.{" "}
              <Link
                href={`/expenses/${expense.id}/edit`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Add one
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
