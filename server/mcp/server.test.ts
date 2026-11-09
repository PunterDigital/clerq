import { TRPCError } from "@trpc/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ClerqCaller } from "./caller";
import { verifyInvoicePdfToken } from "./pdf-link";
import { createClerqMcpServer } from "./server";

const businessId = "22222222-2222-2222-2222-222222222222";
const baseUrl = "https://clerq.example.com";
const SECRET = "test-secret-do-not-use-in-prod";

// Records every caller method the tools invoke, so a test can assert exactly
// what was forwarded to the tRPC layer (and in what shape).
type Recorded = { method: string; input: unknown };

function buildFakeCaller(recorded: Recorded[]) {
  const rec =
    (method: string, result: unknown) =>
    async (input?: unknown) => {
      recorded.push({ method, input });
      if (result instanceof Error) throw result;
      return typeof result === "function"
        ? (result as (i: unknown) => unknown)(input)
        : result;
    };

  return {
    business: {
      current: rec("business.current", {
        id: businessId,
        name: "Acme Studio",
        currency: "EUR",
      }),
    },
    clients: {
      list: rec("clients.list", [{ id: "c1", name: "Northwind" }]),
      get: rec("clients.get", (input: { clientId: string }) => ({
        id: input.clientId,
        name: "Northwind Ltd",
        contacts: [{ name: "Old Contact" }],
        notes: "be nice",
        vatNumber: "GB123",
        defaultRateMinor: 6200,
        defaultRateCurrency: "EUR",
      })),
      create: rec("clients.create", (input: unknown) => ({ id: "c-new", ...(input as object) })),
      update: rec("clients.update", (input: { clientId: string; data: unknown }) => ({
        id: input.clientId,
        ...(input.data as object),
      })),
      addNote: rec("clients.addNote", { id: "c1" }),
      activity: rec("clients.activity", []),
      archive: rec("clients.archive", { id: "c1" }),
      unarchive: rec("clients.unarchive", { id: "c1" }),
    },
    time: {
      logManual: rec("time.logManual", (input: unknown) => ({ id: "te1", ...(input as object) })),
    },
    invoices: {
      get: rec("invoices.get", (input: { invoiceId: string }) => ({
        id: input.invoiceId,
        number: "2026-0001",
        lines: [],
      })),
    },
    recurring: {
      create: rec("recurring.create", (input: unknown) => ({
        id: "rs1",
        ...(input as object),
      })),
      setStatus: rec("recurring.setStatus", (input: unknown) => ({
        id: "rs1",
        ...(input as object),
      })),
    },
    expenses: {
      list: rec("expenses.list", [
        { id: "e1", description: "Hosting", status: "unpaid" },
      ]),
      get: rec("expenses.get", (input: { expenseId: string }) => ({
        id: input.expenseId,
        description: "Camera",
        amountMinor: 90000,
        currency: "EUR",
        status: "unpaid",
        receiptDataUrl: "data:image/png;base64,AAAA",
        receiptFilename: "camera.png",
      })),
      setStatus: rec("expenses.setStatus", (input: unknown) => ({
        id: "e1",
        ...(input as object),
      })),
      create: rec("expenses.create", (input: unknown) => ({
        id: "e-new",
        ...(input as object),
      })),
      update: rec("expenses.update", (input: { expenseId: string }) => ({
        id: input.expenseId,
      })),
      tags: {
        list: rec("expenses.tags.list", {
          tags: [
            { id: "t-travel", name: "Travel", color: "blue", expenseCount: 2 },
            { id: "t-client", name: "Client A", color: "teal", expenseCount: 1 },
          ],
          canManage: true,
          canCreate: true,
        }),
        ensure: rec("expenses.tags.ensure", (input: { names: string[] }) =>
          input.names.map((name) => ({ id: `t-${name.toLowerCase()}`, name, color: "gray" })),
        ),
      },
    },
    team: {
      list: rec("team.list", {
        members: [{ userId: "owner-a", name: "Owner", role: "owner" }],
        invitations: [],
        role: "owner",
      }),
      invite: rec("team.invite", (input: unknown) => ({
        id: "inv1",
        token: "tok_abc",
        ...(input as object),
      })),
    },
  } as unknown as ClerqCaller;
}

async function connectClient(caller: ClerqCaller) {
  const server = createClerqMcpServer({ caller, businessId, baseUrl });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

function jsonOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

describe("Clerq MCP server", () => {
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = SECRET;
  });

  it("exposes the full tool surface", async () => {
    const client = await connectClient(buildFakeCaller([]));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Every domain the platform covers must be reachable.
    expect(names).toEqual(
      expect.arrayContaining([
        "whoami",
        "list_clients",
        "get_client",
        "create_client",
        "update_client",
        "set_client_contacts",
        "add_client_note",
        "get_client_activity",
        "archive_client",
        "unarchive_client",
        "list_projects",
        "create_project",
        "list_tasks",
        "create_task",
        "set_task_status",
        "delete_task",
        "start_timer",
        "stop_timer",
        "log_time",
        "list_invoices",
        "create_draft_invoice",
        "generate_invoice_from_time",
        "add_invoice_line",
        "issue_invoice",
        "mark_invoice_paid",
        "get_invoice_pdf_link",
        "list_recurring_invoices",
        "get_recurring_invoice",
        "create_recurring_invoice",
        "update_recurring_invoice",
        "set_recurring_invoice_status",
        "generate_recurring_invoice_now",
        "delete_recurring_invoice",
        "list_expenses",
        "list_expense_tags",
        "get_expense",
        "create_expense",
        "set_expense_tags",
        "mark_expense_paid",
        "mark_expense_unpaid",
        "delete_expense",
        "list_team_members",
        "invite_team_member",
        "revoke_invitation",
        "remove_team_member",
      ]),
    );
    // Each tool must carry a description - it is the model's only guidance.
    expect(tools.every((t) => (t.description ?? "").length > 0)).toBe(true);
  });

  it("whoami returns the active business", async () => {
    const client = await connectClient(buildFakeCaller([]));
    const result = (await client.callTool({ name: "whoami" })) as CallToolResult;
    expect(jsonOf(result)).toMatchObject({ name: "Acme Studio", currency: "EUR" });
  });

  it("forwards list_clients input to the caller", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "list_clients",
      arguments: { includeArchived: true },
    });
    expect(recorded).toContainEqual({
      method: "clients.list",
      input: { includeArchived: true },
    });
  });

  it("coerces ISO date strings to Date before calling the procedure", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "log_time",
      arguments: {
        taskId: "33333333-3333-4333-8333-333333333333",
        startedAt: "2026-06-12T09:00:00Z",
        durationSeconds: 3600,
      },
    });
    const call = recorded.find((r) => r.method === "time.logManual");
    expect(call).toBeDefined();
    const input = call!.input as { startedAt: unknown };
    expect(input.startedAt).toBeInstanceOf(Date);
    expect((input.startedAt as Date).toISOString()).toBe(
      "2026-06-12T09:00:00.000Z",
    );
  });

  it("create_recurring_invoice coerces the start date and forwards the schedule", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "create_recurring_invoice",
      arguments: {
        clientId: "99999999-9999-4999-8999-999999999999",
        name: "Acme retainer",
        currency: "EUR",
        taxTreatment: "zero_rated",
        frequency: "monthly",
        interval: 1,
        startDate: "2026-07-01T00:00:00Z",
        netTermsDays: 14,
        autoIssue: false,
        lines: [{ description: "Retainer", amountMajor: "1500" }],
      },
    });
    const call = recorded.find((r) => r.method === "recurring.create");
    expect(call).toBeDefined();
    const input = call!.input as { startDate: unknown; endDate: unknown };
    expect(input.startDate).toBeInstanceOf(Date);
    expect((input.startDate as Date).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    // Absent end date is normalised to null, not left undefined.
    expect(input.endDate).toBeNull();
  });

  it("replaces contacts without clobbering other client fields", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "set_client_contacts",
      arguments: {
        clientId: "44444444-4444-4444-8444-444444444444",
        contacts: [{ name: "New Contact", email: "new@northwind.test" }],
      },
    });
    const update = recorded.find((r) => r.method === "clients.update");
    expect(update).toBeDefined();
    const input = update!.input as { data: { contacts: unknown[]; name: string; vatNumber: string } };
    expect(input.data.contacts).toEqual([
      { name: "New Contact", email: "new@northwind.test" },
    ]);
    // Preserved from the fetched client, not dropped.
    expect(input.data.name).toBe("Northwind Ltd");
    expect(input.data.vatNumber).toBe("GB123");
  });

  it("maps a tRPC NOT_FOUND into a readable error result", async () => {
    const recorded: Recorded[] = [];
    const caller = buildFakeCaller(recorded);
    // Override get to reject like the real procedure does for a foreign id.
    (caller as unknown as { clients: { get: () => Promise<never> } }).clients.get =
      async () => {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such client" });
      };
    const client = await connectClient(caller);
    const result = (await client.callTool({
      name: "get_client",
      arguments: { clientId: "55555555-5555-4555-8555-555555555555" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not found");
    expect(textOf(result)).toContain("No such client");
  });

  it("mints a verifiable, invoice-scoped PDF link", async () => {
    const client = await connectClient(buildFakeCaller([]));
    const invoiceId = "66666666-6666-4666-8666-666666666666";
    const result = (await client.callTool({
      name: "get_invoice_pdf_link",
      arguments: { invoiceId },
    })) as CallToolResult;
    const payload = jsonOf(result) as { url: string; invoiceNumber: string };
    expect(payload.invoiceNumber).toBe("2026-0001");

    const url = new URL(payload.url);
    expect(url.origin + url.pathname).toBe(
      `${baseUrl}/api/invoices/${invoiceId}/pdf`,
    );
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    const verified = verifyInvoicePdfToken(token!, { secret: SECRET });
    expect(verified).toMatchObject({ invoiceId, businessId });
  });

  it("mark_expense_paid forwards the paid status to the caller", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "mark_expense_paid",
      arguments: { expenseId: "77777777-7777-4777-8777-777777777777" },
    });
    expect(recorded).toContainEqual({
      method: "expenses.setStatus",
      input: { expenseId: "77777777-7777-4777-8777-777777777777", status: "paid" },
    });
  });

  it("list_expenses turns tag names into ids, ignoring case", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "list_expenses",
      arguments: { status: "paid", tags: ["travel", "Nope"] },
    });
    expect(recorded).toContainEqual({
      method: "expenses.list",
      input: { status: "paid", tagIds: ["t-travel"] },
    });
  });

  it("list_expenses with only unknown tag names matches nothing", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    const result = (await client.callTool({
      name: "list_expenses",
      arguments: { tags: ["Nope"] },
    })) as CallToolResult;
    expect(jsonOf(result)).toEqual([]);
    expect(recorded.map((r) => r.method)).not.toContain("expenses.list");
  });

  it("create_expense creates missing tags by name and passes their ids", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "create_expense",
      arguments: {
        description: "Train",
        amountMinor: 4200,
        currency: "EUR",
        incurredAt: "2026-11-02T00:00:00.000Z",
        tags: ["Travel"],
      },
    });
    expect(recorded).toContainEqual({
      method: "expenses.tags.ensure",
      input: { names: ["Travel"] },
    });
    expect(recorded).toContainEqual(
      expect.objectContaining({
        method: "expenses.create",
        input: expect.objectContaining({ tagIds: ["t-travel"] }),
      }),
    );
  });

  it("create_expense without tags sends no tag ids (the Panel sync shape)", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    await client.callTool({
      name: "create_expense",
      arguments: {
        description: "Hosting",
        amountMinor: 900,
        currency: "EUR",
        incurredAt: "2026-11-02T00:00:00.000Z",
      },
    });
    const create = recorded.find((r) => r.method === "expenses.create");
    expect((create?.input as { tagIds?: unknown }).tagIds).toBeUndefined();
    expect(recorded.map((r) => r.method)).not.toContain("expenses.tags.ensure");
  });

  it("set_expense_tags keeps every other field and the receipt", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    const expenseId = "99999999-9999-4999-8999-999999999999";
    const result = (await client.callTool({
      name: "set_expense_tags",
      arguments: { expenseId, tags: ["Travel", "Client A"] },
    })) as CallToolResult;
    const update = recorded.find((r) => r.method === "expenses.update");
    const data = (update?.input as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      description: "Camera",
      amountMinor: 90000,
      currency: "EUR",
      tagIds: ["t-travel", "t-client a"],
    });
    expect("receipt" in data).toBe(false);
    expect((jsonOf(result) as Record<string, unknown>).receiptDataUrl).toBeUndefined();
  });

  it("get_expense omits the receipt data URL but flags its presence", async () => {
    const client = await connectClient(buildFakeCaller([]));
    const result = (await client.callTool({
      name: "get_expense",
      arguments: { expenseId: "88888888-8888-4888-8888-888888888888" },
    })) as CallToolResult;
    const payload = jsonOf(result) as Record<string, unknown>;
    expect(payload.receiptDataUrl).toBeUndefined();
    expect(payload.hasReceipt).toBe(true);
    expect(payload.receiptFilename).toBe("camera.png");
  });

  it("invite_team_member returns a shareable invite link built from the base URL", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    const result = (await client.callTool({
      name: "invite_team_member",
      arguments: { email: "teammate@example.com", role: "member" },
    })) as CallToolResult;
    const payload = jsonOf(result) as { inviteUrl: string; token: string };
    expect(payload.inviteUrl).toBe(`${baseUrl}/invite/tok_abc`);
    expect(recorded).toContainEqual({
      method: "team.invite",
      input: { email: "teammate@example.com", role: "member" },
    });
  });

  it("rejects input that violates the tool schema", async () => {
    const recorded: Recorded[] = [];
    const client = await connectClient(buildFakeCaller(recorded));
    // clientId must be a uuid; the SDK validates against the tool schema
    // before the handler runs and returns an error result.
    const result = (await client.callTool({
      name: "get_client",
      arguments: { clientId: "not-a-uuid" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("validation");
    // The bad call never reached the tRPC layer.
    expect(recorded).toHaveLength(0);
  });
});
