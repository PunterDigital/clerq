import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  API_OPERATIONS,
  API_TAGS,
  buildOpenApiDocument,
  operationId,
  pathParams,
} from "./openapi";

// The OpenAPI document against the route files on disk: an endpoint added
// under app/api/v1 without an entry in API_OPERATIONS (or an entry left behind
// after its route went) fails here.

const v1Dir = fileURLToPath(new URL("../../app/api/v1/", import.meta.url));

// The JSON 404 for paths with no endpoint isn't an endpoint.
const NOT_ENDPOINTS = ["[...path]/route.ts"];

function routeFiles(): string[] {
  return readdirSync(v1Dir, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => file.endsWith("route.ts") && !NOT_ENDPOINTS.includes(file));
}

// "clients/[clientId]/notes/route.ts" -> "/clients/{clientId}/notes"
function routePath(file: string): string {
  return (
    "/" +
    file
      .replace(/\/?route\.ts$/, "")
      .replace(/\[(\w+)\]/g, "{$1}")
  );
}

function routeEndpoints(): string[] {
  const endpoints: string[] = [];
  for (const file of routeFiles()) {
    const source = readFileSync(v1Dir + file, "utf8");
    const methods = [
      ...source.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g),
    ].map((m) => m[1]!.toLowerCase());
    expect(methods.length, `${file} exports no handler`).toBeGreaterThan(0);
    for (const method of methods) endpoints.push(`${method} ${routePath(file)}`);
  }
  return endpoints.sort();
}

const doc = buildOpenApiDocument("https://clerq.example", "1.2.3");
type Operation = {
  operationId: string;
  tags: string[];
  parameters?: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[];
  requestBody?: {
    required: boolean;
    content: { "application/json": { schema: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  responses: Record<string, unknown>;
  security?: unknown[];
};
const operations = doc.paths as Record<string, Record<string, Operation>>;
const op = (method: string, path: string) => operations[path]![method]!;
const bodyOf = (method: string, path: string) =>
  op(method, path).requestBody!.content["application/json"].schema;

describe("the OpenAPI document", () => {
  it("lists every /api/v1 endpoint, and nothing else", () => {
    const documented = Object.entries(operations)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m} ${path}`))
      .sort();
    const routes = routeEndpoints();
    expect(routes.length).toBeGreaterThan(50);
    expect(documented).toEqual(routes);
  });

  it("is OpenAPI 3.1 with unique operation ids and known tags", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
    expect(doc.servers).toEqual([{ url: "https://clerq.example/api/v1" }]);
    const ids = API_OPERATIONS.map(operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set<string>(API_TAGS.map((t) => t.name));
    for (const o of API_OPERATIONS) expect(tags, o.path).toContain(o.tag);
    // Survives a JSON round trip (no Dates, functions or undefined left in).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("documents each path parameter", () => {
    for (const o of API_OPERATIONS) {
      const params = op(o.method, o.path).parameters ?? [];
      for (const name of pathParams(o.path)) {
        expect(params, `${o.method} ${o.path}`).toContainEqual(
          expect.objectContaining({ name, in: "path", required: true }),
        );
      }
    }
  });

  it("converts request bodies from the endpoints' Zod schemas", () => {
    const client = bodyOf("post", "/clients");
    expect(client.type).toBe("object");
    expect(client.required).toEqual(["name"]);
    expect(client.properties.defaultRateUnit.enum).toEqual(["hour", "day"]);

    // A PATCH sends only what changes.
    expect(bodyOf("patch", "/clients/{clientId}").required).toBeUndefined();
    expect(bodyOf("patch", "/clients/{clientId}").properties).toHaveProperty("contacts");

    // Dates go over the wire as ISO 8601 strings.
    const entry = bodyOf("post", "/time-entries");
    expect(entry.properties.startedAt).toMatchObject({ type: "string" });
    expect(entry.required).toEqual(expect.arrayContaining(["taskId", "startedAt", "durationSeconds"]));
    // billable has a default, so callers may leave it out.
    expect(entry.required).not.toContain("billable");

    // A task's project comes in the body; its status has a default.
    expect(bodyOf("post", "/tasks").required).toEqual(expect.arrayContaining(["projectId", "title"]));
    expect(bodyOf("post", "/tasks").required).not.toContain("status");

    // Receipts aren't accepted, and generate-from-time takes its id from the path.
    expect(bodyOf("post", "/expenses").properties).not.toHaveProperty("receipt");
    expect(bodyOf("patch", "/expenses/{expenseId}").properties).not.toHaveProperty("receipt");
    expect(bodyOf("post", "/invoices/{invoiceId}/generate-from-time").properties).not.toHaveProperty("invoiceId");

    expect(bodyOf("post", "/tasks/{taskId}/status").properties.status.enum).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "done",
    ]);
    expect(op("post", "/invoices/{invoiceId}/void").requestBody!.required).toBe(false);
  });

  it("describes lists, errors and auth", () => {
    const list = op("get", "/clients");
    expect(list.parameters!.map((p) => p.name)).toEqual(
      expect.arrayContaining(["search", "includeArchived", "limit", "cursor"]),
    );
    expect(list.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/Page" } } },
    });
    expect(op("post", "/clients").responses).toHaveProperty("201");
    expect(op("post", "/invoices/{invoiceId}/issue").responses).toHaveProperty("409");
    expect(op("get", "/clients/{clientId}").responses).toHaveProperty("404");
    expect(op("get", "/health").responses).toHaveProperty("401");

    expect(doc.security).toEqual([{ apiKey: [] }]);
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
    // The document itself needs no key.
    expect(op("get", "/openapi.json").security).toEqual([]);
    expect(op("get", "/openapi.json").responses).not.toHaveProperty("401");
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("answers without a key, for the host the caller used", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = GET(
      new Request("http://0.0.0.0:3000/api/v1/openapi.json", {
        headers: { "x-forwarded-host": "app.useclerq.net", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.servers).toEqual([{ url: "https://app.useclerq.net/api/v1" }]);
    expect(Object.keys(body.paths)).toContain("/clients/{clientId}");
  });
});
