import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isReceiptScanConfigured } from "@/modules/expenses/ocr";
import { caller } from "@/server/trpc/server";

import { ExpenseForm } from "../../expense-form";

export const metadata: Metadata = {
  title: "Edit expense - Clerq",
};

export const dynamic = "force-dynamic";

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ expenseId: string }>;
}) {
  const { expenseId } = await params;
  let expense;
  try {
    expense = await caller.expenses.get({ expenseId });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <h1 className="text-2xl">Edit expense</h1>
      <ExpenseForm
        defaultCurrency={expense.currency}
        scanEnabled={isReceiptScanConfigured()}
        initial={{
          id: expense.id,
          description: expense.description,
          amountMinor: expense.amountMinor,
          currency: expense.currency,
          vendor: expense.vendor,
          category: expense.category,
          incurredAt: expense.incurredAt,
          notes: expense.notes,
          receiptFilename: expense.receiptFilename,
          tagIds: expense.tags.map((tag) => tag.id),
        }}
      />
    </div>
  );
}
