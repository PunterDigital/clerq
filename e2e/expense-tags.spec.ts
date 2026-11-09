import { expect, test, type Page } from "@playwright/test";

import { DEMO_STATE } from "./env";

// Expense tags (#4395): manage tags, tag expenses (including a tag created
// inline in the form), filter the list by tags through the URL, and delete a
// tag without losing its expenses. Signed in as the demo owner with the saved
// session (no extra sign-in: Better Auth allows 3 per 10 s per IP).
test.use({ storageState: DEMO_STATE });

async function addExpense(page: Page, description: string, tags: string[], inline?: string) {
  await page.goto("/expenses/new");
  await expect(page.getByRole("heading", { name: "New expense" })).toBeVisible();
  await page.getByLabel("Description").fill(description);
  await page.getByLabel("Amount").fill("42.00");
  const picker = page.getByRole("group", { name: "Tags (optional)" });
  for (const name of tags) {
    const toggle = picker.getByRole("button", { name, exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  }
  if (inline) {
    await page.getByLabel("New tag name").fill(inline);
    await page.getByRole("button", { name: "Add tag" }).click();
    // The new tag appears in the picker already selected.
    await expect(picker.getByRole("button", { name: inline, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: description })).toBeVisible();
}

function listRow(page: Page, description: string) {
  return page.getByRole("link").filter({ hasText: description });
}

test("expense tags: manage, tag, filter by URL, delete", async ({ page }) => {
  const errors: string[] = [];
  // Page errors only: the refused duplicate below is a 409 the browser logs.
  page.on("pageerror", (error) => errors.push(error.message));
  // Unique per run: the E2E database is reused across local runs and retries.
  const run = Date.now().toString(36);
  const trip = `Trip ${run}`;
  const clientOld = `Clent ${run}`;
  const client = `Client ${run}`;
  const inline = `Inline ${run}`;
  const first = `Train fare ${run}`;
  const second = `Client lunch ${run}`;

  // -- Manage: create two tags, fix one's name and colour.
  await page.goto("/expenses/tags");
  await expect(page.getByRole("heading", { name: "Expense tags" })).toBeVisible();
  for (const [name, colour] of [
    [trip, "Blue"],
    [clientOld, "Grey"],
  ] as const) {
    await page.getByLabel("New tag", { exact: true }).fill(name);
    await page.getByLabel("Colour", { exact: true }).selectOption({ label: colour });
    await page.getByRole("button", { name: "Create tag" }).click();
    await expect(page.getByTestId("tag-row").filter({ hasText: name })).toBeVisible();
  }
  // A clash ignoring case is refused with a message.
  await page.getByLabel("New tag", { exact: true }).fill(trip.toUpperCase());
  await page.getByRole("button", { name: "Create tag" }).click();
  await expect(page.getByText(`A tag called "${trip.toUpperCase()}" already exists`)).toBeVisible();
  await page.getByLabel("New tag", { exact: true }).fill("");

  const oldRow = page.getByTestId("tag-row").filter({ hasText: clientOld });
  await oldRow.getByRole("button", { name: "Edit" }).click();
  const editing = page.getByTestId("tag-row").filter({ has: page.getByLabel("Tag name") });
  await editing.getByLabel("Tag name").fill(client);
  await editing.getByLabel("Tag colour").selectOption({ label: "Green" });
  await editing.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("tag-row").filter({ hasText: client })).toBeVisible();
  await expect(page.getByTestId("tag-row").filter({ hasText: clientOld })).toHaveCount(0);

  // -- Tag expenses: one with an existing tag plus one made inline.
  await addExpense(page, first, [trip], inline);
  const detailTags = page.getByTestId("expense-tag");
  await expect(detailTags.filter({ hasText: trip })).toBeVisible();
  await expect(detailTags.filter({ hasText: inline })).toBeVisible();
  const firstUrl = page.url();

  await addExpense(page, second, [client]);

  // Editing keeps the tags selected, and saving without changes keeps them.
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "Tags (optional)" })
      .getByRole("button", { name: client, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: second })).toBeVisible();
  await expect(page.getByTestId("expense-tag").filter({ hasText: client })).toBeVisible();

  // -- Filter: by one tag, survive a reload, then match any of two.
  await page.goto("/expenses");
  const filters = page.getByRole("navigation", { name: "Filter by tag" });
  await filters.getByRole("link", { name: trip, exact: true }).click();
  await expect(page).toHaveURL(/[?&]tag=/);
  await expect(listRow(page, first)).toBeVisible();
  await expect(listRow(page, second)).toHaveCount(0);
  await page.reload();
  await expect(listRow(page, first)).toBeVisible();
  await expect(listRow(page, second)).toHaveCount(0);
  await expect(
    filters.getByRole("link", { name: trip, exact: true }),
  ).toHaveAttribute("aria-current", "true");

  await filters.getByRole("link", { name: client, exact: true }).click();
  await expect(listRow(page, first)).toBeVisible();
  await expect(listRow(page, second)).toBeVisible();

  // Status composes with the tags: nothing here is paid yet.
  await page.getByRole("link", { name: "Paid", exact: true }).click();
  await expect(page).toHaveURL(/status=paid/);
  await expect(page).toHaveURL(/tag=/);
  await expect(listRow(page, first)).toHaveCount(0);

  await page.getByRole("link", { name: "All", exact: true }).click();
  await filters.getByRole("link", { name: "Clear tags" }).click();
  await expect(page).not.toHaveURL(/tag=/);

  // -- Delete a tag: it comes off the expense, the expense stays.
  await page.goto("/expenses/tags");
  const inlineRow = page.getByTestId("tag-row").filter({ hasText: inline });
  await expect(inlineRow).toContainText("1 expense");
  await inlineRow.getByRole("button", { name: "Delete", exact: true }).click();
  await inlineRow.getByRole("button", { name: "Delete tag" }).click();
  await expect(page.getByTestId("tag-row").filter({ hasText: inline })).toHaveCount(0);

  await page.goto(firstUrl);
  await expect(page.getByRole("heading", { name: first })).toBeVisible();
  await expect(page.getByTestId("expense-tag").filter({ hasText: trip })).toBeVisible();
  await expect(page.getByTestId("expense-tag").filter({ hasText: inline })).toHaveCount(0);

  expect(errors).toEqual([]);
});
