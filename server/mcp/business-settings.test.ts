import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import { createClerqCaller, mcpContextForUser } from "./caller";
import { createClerqMcpServer } from "./server";

// Business settings over MCP (#5260), through the real tRPC caller on PGlite:
// partial updates keep every field left out, and the Settings page's
// permissions and read-only API keys still apply.

let pglite: PGlite;
let db: Db;
let bizId = "";

const LOGO = "data:image/png;base64,iVBORw0KGgo=";

async function connect(
  userId: string,
  apiKey?: { id: string; businessId: string; scope: "read" | "write" },
) {
  const caller = createClerqCaller(mcpContextForUser(userId, new Headers(), apiKey));
  const server = createClerqMcpServer({
    caller,
    businessId: bizId,
    baseUrl: "https://clerq.example.com",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const part = result.content[0];
  const text = part?.type === "text" ? part.text : "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An error message, not JSON.
  }
  return { isError: result.isError === true, text, json };
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-mcp-business-settings";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db.insert(schema.user).values([
    { id: "olive", name: "Olive", email: "olive@t.dev" },
    { id: "mike", name: "Mike", email: "mike@t.dev" },
    { id: "cora", name: "Cora", email: "cora@t.dev" },
  ]);
  const [biz] = await db
    .insert(schema.business)
    .values({ name: "Acme Studio", currency: "EUR" })
    .returning();
  bizId = biz.id;
  await db.insert(schema.businessMember).values([
    { businessId: bizId, userId: "olive", role: "owner" },
    { businessId: bizId, userId: "mike", role: "member" },
    { businessId: bizId, userId: "cora", role: "contractor" },
  ]);
  await db.insert(schema.userActiveBusiness).values([
    { userId: "olive", businessId: bizId },
    { userId: "mike", businessId: bizId },
    { userId: "cora", businessId: bizId },
  ]);
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(async () => {
  await db
    .update(schema.business)
    .set({
      name: "Acme Studio",
      currency: "EUR",
      hoursPerDay: 8,
      address: "1 Main St\nAmsterdam",
      postalAddress: { street: "1 Main St", city: "Amsterdam", postcode: "1011AA", region: null, country: "NL" },
      taxConfig: { standardRatePct: "21", vatNumber: "NL123456789B01" },
      einvoicingEnabled: false,
      iban: null,
      bic: null,
      einvoiceContact: null,
      peppolId: null,
      companyNumber: null,
      companyNumberScheme: null,
      creditNotePrefix: "CN-",
      branding: { logoDataUrl: LOGO, brandColor: "#228E80", footerNote: "Thanks!" },
    })
    .where(eq(schema.business.id, bizId));
});

describe("business settings MCP tools", () => {
  it("get_business_settings returns the settings without the logo", async () => {
    const client = await connect("olive");
    const res = await call(client, "get_business_settings");
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      name: "Acme Studio",
      address: "1 Main St\nAmsterdam",
      postalAddress: { city: "Amsterdam", country: "NL" },
      currency: "EUR",
      standardRatePct: "21",
      vatNumber: "NL123456789B01",
      creditNotePrefix: "CN-",
      brandColor: "#228E80",
      footerNote: "Thanks!",
      hasLogo: true,
    });
    expect(res.json).not.toHaveProperty("logoDataUrl");
  });

  it("update_business_settings changes only the fields passed", async () => {
    const client = await connect("olive");
    const res = await call(client, "update_business_settings", {
      address: "2 Canal St\nUtrecht",
      postalAddress: { street: "2 Canal St", city: "Utrecht", postcode: "3511AA", country: "NL" },
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      name: "Acme Studio",
      address: "2 Canal St\nUtrecht",
      postalAddress: { city: "Utrecht" },
      currency: "EUR",
      hoursPerDay: 8,
      standardRatePct: "21",
      vatNumber: "NL123456789B01",
    });

    // null clears; the rest still stays.
    const cleared = await call(client, "update_business_settings", { vatNumber: null, name: "Acme BV" });
    expect(cleared.json).toMatchObject({ name: "Acme BV", vatNumber: null, standardRatePct: "21" });
    expect(cleared.json.address).toBe("2 Canal St\nUtrecht");
  });

  it("update_business_settings reports validation errors and changes nothing", async () => {
    const client = await connect("olive");
    const res = await call(client, "update_business_settings", { standardRatePct: "twenty" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/plain number/i);
    const [row] = await db.select().from(schema.business).where(eq(schema.business.id, bizId));
    expect(row.taxConfig).toEqual({ standardRatePct: "21", vatNumber: "NL123456789B01" });
  });

  it("update_einvoicing_settings turns it on and keeps fields left out", async () => {
    const client = await connect("olive");
    const on = await call(client, "update_einvoicing_settings", {
      enabled: true,
      iban: "NL91 ABNA 0417 1643 00",
      contact: { name: "Olive", email: "billing@acme.example" },
    });
    expect(on.isError).toBe(false);
    expect(on.json).toMatchObject({
      einvoicingEnabled: true,
      iban: "NL91ABNA0417164300",
      einvoiceContact: { name: "Olive", email: "billing@acme.example" },
      postalAddress: { country: "NL" },
    });

    // Only the BIC: e-invoicing stays on, the IBAN stays.
    const bic = await call(client, "update_einvoicing_settings", { bic: "ABNANL2A" });
    expect(bic.json).toMatchObject({ einvoicingEnabled: true, iban: "NL91ABNA0417164300", bic: "ABNANL2A" });

    // While on, the business address can't leave the EEA.
    const uk = await call(client, "update_business_settings", {
      postalAddress: { street: "1 High St", city: "London", postcode: "E1 6AN", country: "GB" },
    });
    expect(uk.isError).toBe(true);
  });

  it("update_branding keeps the logo and fields left out", async () => {
    const client = await connect("olive");
    const res = await call(client, "update_branding", { footerNote: "Payment within 14 days." });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ brandColor: "#228E80", footerNote: "Payment within 14 days.", hasLogo: true });
    const [row] = await db.select().from(schema.business).where(eq(schema.business.id, bizId));
    expect((row.branding as { logoDataUrl?: string }).logoDataUrl).toBe(LOGO);
  });

  it("set_credit_note_prefix changes the prefix", async () => {
    const client = await connect("olive");
    const res = await call(client, "set_credit_note_prefix", { prefix: "CR/" });
    expect(res.isError).toBe(false);
    const settings = await call(client, "get_business_settings");
    expect(settings.json.creditNotePrefix).toBe("CR/");
  });

  it("people without the settings permissions are refused", async () => {
    // A contractor can't even read the settings.
    const contractor = await connect("cora");
    const read = await call(contractor, "get_business_settings");
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(/^Not allowed/);

    // A member reads them but can't change them.
    const client = await connect("mike");
    expect((await call(client, "get_business_settings")).isError).toBe(false);
    for (const [tool, args] of [
      ["update_business_settings", { name: "Hijacked" }],
      ["update_einvoicing_settings", { enabled: true }],
      ["update_branding", { footerNote: "x" }],
      ["set_credit_note_prefix", { prefix: "X-" }],
    ] as const) {
      const res = await call(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toMatch(/^Not allowed/);
    }
    const [row] = await db.select().from(schema.business).where(eq(schema.business.id, bizId));
    expect(row.name).toBe("Acme Studio");
  });

  it("a read-only API key can read the settings but not change them", async () => {
    const client = await connect("olive", { id: "key-read", businessId: bizId, scope: "read" });
    expect((await call(client, "get_business_settings")).isError).toBe(false);
    const res = await call(client, "update_business_settings", { name: "Nope" });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(schema.business).where(eq(schema.business.id, bizId));
    expect(row.name).toBe("Acme Studio");
  });
});
