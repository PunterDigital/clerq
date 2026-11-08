import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { DEMO_STATE } from "./env";

// Signed in as the demo account (an owner, so it may also mark expenses
// paid) with the session e2e/auth.setup.ts saved: no extra sign-in, which
// Better Auth rate-limits to 3 per 10 seconds per IP.
test.use({ storageState: DEMO_STATE });

// A 1x1 PNG. The OpenRouter stub (e2e/openrouter-stub.mjs) reads a marker
// appended after IEND - browsers ignore trailing bytes - and answers with it.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function stubPng(name: string, marker: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([PNG_1X1, Buffer.from(`CLERQ-STUB:${marker}\n`)]),
  };
}

test("bulk upload: scan a batch, review each, save, mark paid and skip", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Unique per run: the E2E database is reused across local runs and retries.
  const run = Date.now().toString(36);
  const hosting = `Alpha hosting ${run}`;
  const byHand = `Typed by hand ${run}`;
  const fromPdf = `Office chairs ${run}`;

  await page.goto("/expenses");
  await page.getByRole("link", { name: "Bulk upload" }).click();
  await expect(page.getByRole("heading", { name: "Bulk upload" })).toBeVisible();

  await page.getByLabel("Receipt files").setInputFiles([
    stubPng(
      "alpha.png",
      JSON.stringify({
        description: hosting,
        amount: 12.5,
        currency: "EUR",
        vendor: "Alpha Hosting",
        category: "Software",
        date: "2026-10-01",
        notes: "Invoice A-1",
      }),
    ),
    stubPng("blurry.png", "FAIL"),
    {
      name: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: readFileSync("docs/test-artifacts/invoice-2026-0001.pdf"),
    },
    stubPng(
      "duplicate.png",
      JSON.stringify({ description: "Duplicate", amount: 1, currency: "EUR" }),
    ),
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
  ]);

  // The text file is refused; the other four are queued and scanned. (Not
  // getByRole("alert"): Next's route announcer is an alert too.)
  await expect(page.getByText("notes.txt: Not a PNG, JPEG or PDF")).toBeVisible();
  const files = page.getByRole("list", { name: "Files" });
  await expect(files.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("4 of 4 scanned")).toBeVisible({ timeout: 30_000 });
  await expect(files.getByText("Scan failed")).toHaveCount(1);

  await page.getByRole("button", { name: "Review 4 expenses" }).click();

  // 1: read from the scan; mark it paid.
  await expect(page.getByText("Expense 1 of 4")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue(hosting);
  await expect(page.getByLabel("Amount")).toHaveValue("12.50");
  await expect(page.getByLabel("Currency")).toHaveValue("EUR");
  await expect(page.getByLabel("Date")).toHaveValue("2026-10-01");
  await expect(page.getByLabel("Vendor (optional)")).toHaveValue("Alpha Hosting");
  await expect(page.getByText("Attaching alpha.png")).toBeVisible();
  await expect(page.getByAltText("Preview of alpha.png")).toBeVisible();
  await page.getByLabel("Mark as paid").check();
  await page.getByRole("button", { name: "Save and next" }).click();

  // 2: the scan failed, so the fields are typed in by hand.
  await expect(page.getByText("Expense 2 of 4")).toBeVisible();
  await expect(page.getByText(/Could not scan this file/)).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("");
  await expect(page.getByText("Attaching blurry.png")).toBeVisible();
  await page.getByLabel("Description").fill(byHand);
  await page.getByLabel("Amount").fill("8.00");
  await page.getByRole("button", { name: "Save and next" }).click();

  // 3: the PDF's first page was turned into an image and scanned.
  await expect(page.getByText("Expense 3 of 4")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Scanned PDF invoice");
  await expect(page.getByLabel("Amount")).toHaveValue("120.00");
  await expect(page.getByLabel("Vendor (optional)")).toHaveValue("Stub Supplier");
  await expect(page.getByText("Attaching invoice.pdf")).toBeVisible();
  await page.getByLabel("Description").fill(fromPdf);
  await page.getByRole("button", { name: "Save and next" }).click();

  // 4: skipped, so it is never saved.
  await expect(page.getByText("Expense 4 of 4")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and finish" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toContainText(
    "Saved 3 expenses (1 marked paid), skipped 1.",
  );

  // The saved expenses are in the list; only the first is paid.
  await page.getByRole("link", { name: "Back to expenses" }).click();
  await expect(page).toHaveURL(/\/expenses$/);
  await expect(page.getByText(hosting)).toBeVisible();
  await expect(page.getByText(byHand)).toBeVisible();
  await expect(page.getByText(fromPdf)).toBeVisible();

  await page.goto("/expenses?status=paid");
  await expect(page.getByText(hosting)).toBeVisible();
  await expect(page.getByText(byHand)).toHaveCount(0);

  // The scanned file is stored as the expense's receipt.
  await page.getByText(hosting).click();
  await expect(page.getByRole("heading", { name: hosting })).toBeVisible();
  await expect(page.getByAltText("alpha.png")).toBeVisible();

  expect(errors).toEqual([]);
});
