import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isReceiptScanConfigured } from "@/modules/expenses/ocr";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { caller } from "@/server/trpc/server";

import { BulkUpload } from "./bulk-upload";

export const metadata: Metadata = {
  title: "Bulk upload expenses - Clerq",
};

export const dynamic = "force-dynamic";

export default async function BulkUploadPage() {
  const business = await caller.business.current();
  const session = await getAuth().api.getSession({ headers: await headers() });
  const membership = session
    ? await getActiveMembership(session.user.id)
    : null;
  const canCreate = membership?.permissions.has("expenses.create") ?? false;
  // Marking paid is its own permission (the detail page's "Mark paid" button).
  const canMarkPaid = membership?.permissions.has("expenses.approve") ?? false;
  const scanEnabled = isReceiptScanConfigured();

  const blocker = !canCreate
    ? "Your role can't record expenses."
    : !scanEnabled
      ? "Bulk upload reads each file with Scan with AI, which isn't set up on this instance (OPENROUTER_API_KEY)."
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl">Bulk upload</h1>
        <p className="text-sm text-muted-foreground">
          Upload a batch of receipts or invoices. Each one is read with AI,
          then you check it, and save it or skip it.
        </p>
      </div>
      {blocker ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-4 pt-6">
            <p className="text-sm">{blocker}</p>
            <Button variant="outline" asChild>
              <Link href="/expenses">Back to expenses</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <BulkUpload
          defaultCurrency={business.currency}
          canMarkPaid={canMarkPaid}
        />
      )}
    </div>
  );
}
