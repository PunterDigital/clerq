import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { DEMO_STATE } from "./env";

// Card #5584: the security headers are on every response, the CSP doesn't
// block anything the app itself loads, and tRPC refuses a form post.
test.use({ storageState: DEMO_STATE });

const PAGES = [
  "/",
  "/clients",
  "/projects",
  "/time",
  "/invoices",
  "/invoices/credit-notes",
  "/expenses",
  "/expenses/bulk",
  "/settings",
  "/settings/api",
  "/settings/api/docs",
];

test("security headers are set and the CSP blocks nothing on the main pages", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) {
      violations.push(`${page.url()}: ${msg.text()}`);
    }
  });

  const res = await page.goto("/");
  const headers = res!.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-powered-by"]).toBeUndefined();

  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }

  // A PDF in the bulk upload: pdf.js and its worker render the first page
  // in the browser, and the review shows it in a blob: frame.
  await page.goto("/expenses/bulk");
  await page.getByLabel("Receipt files").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync("docs/test-artifacts/invoice-2026-0001.pdf"),
  });
  await expect(page.getByText("1 of 1 scanned")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Review 1 expense" }).click();
  await expect(page.getByText("Attaching invoice.pdf")).toBeVisible();

  expect(violations).toEqual([]);
});

test("tRPC refuses a form-encoded mutation", async ({ page }) => {
  const res = await page.request.post("/api/trpc/clients.create", {
    multipart: { name: "Form CSRF probe" },
  });
  expect(res.status()).toBe(415);
  const form = await page.request.post("/api/trpc/clients.create", {
    form: { name: "Form CSRF probe" },
  });
  expect(form.status()).toBe(415);
});
