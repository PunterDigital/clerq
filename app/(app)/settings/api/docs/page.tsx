import type { Metadata } from "next";
import { headers } from "next/headers";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  API_ERRORS,
  API_OPERATIONS,
  API_TAGS,
  publicOrigin,
  toJsonSchema,
  type ApiOperation,
} from "@/server/api/openapi";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RATE_LIMIT_PER_MINUTE,
} from "@/server/api/v1";

export const metadata: Metadata = {
  title: "API documentation - Clerq",
};

export const dynamic = "force-dynamic";

// The REST API reference. The endpoint list and every request body below are
// rendered from the same operations and Zod schemas as /api/v1/openapi.json,
// so this page can't drift from the API either.

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  format?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

function typeOf(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" | ");
  if (schema.type === "array") return `array of ${typeOf(schema.items ?? {})}`;
  if (schema.type === "object" && schema.properties) {
    return `object (${Object.keys(schema.properties).join(", ")})`;
  }
  if (schema.format === "uuid") return "uuid";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "any";
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function Example({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
      {children}
    </pre>
  );
}

function FieldList({
  title,
  fields,
}: {
  title: string;
  fields: { name: string; type: string; required: boolean; note?: string }[];
}) {
  if (fields.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1 text-xs">
        {fields.map((field) => (
          <li key={field.name} className="break-words">
            <Code>{field.name}</Code>{" "}
            <span className="text-muted-foreground">
              {field.type}
              {field.required ? ", required" : ""}
              {field.note ? `. ${field.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Endpoint({ op }: { op: ApiOperation }) {
  const query = Object.entries(op.query ?? {}).map(([name, param]) => ({
    name,
    type: typeOf(toJsonSchema(param.schema) as JsonSchema),
    required: param.required ?? false,
    note: param.description,
  }));
  if (op.paged) {
    query.push(
      { name: "limit", type: `1 to ${MAX_PAGE_SIZE}`, required: false, note: `Default ${DEFAULT_PAGE_SIZE}.` },
      { name: "cursor", type: "string", required: false, note: "The previous page's nextCursor." },
    );
  }
  const body = op.body ? (toJsonSchema(op.body) as JsonSchema) : null;
  const bodyFields = Object.entries(body?.properties ?? {}).map(([name, schema]) => ({
    name,
    type: typeOf(schema),
    required: body?.required?.includes(name) ?? false,
  }));
  const notes = [
    op.creates ? "Answers 201." : null,
    op.conflict ? `409 when: ${op.conflict}` : null,
    op.public ? "No key needed." : null,
  ].filter((note): note is string => note !== null);

  return (
    <li
      data-testid="api-endpoint"
      className="flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0"
    >
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs font-semibold uppercase text-[var(--primary-subtle-fg)]">
          {op.method}
        </span>
        <span className="font-mono text-sm break-all">{op.path}</span>
      </p>
      <p className="text-sm">
        {op.summary}
        {op.description ? (
          <span className="text-muted-foreground">. {op.description}</span>
        ) : null}
      </p>
      {notes.length > 0 ? (
        <p className="text-xs text-muted-foreground">{notes.join(" ")}</p>
      ) : null}
      <FieldList title="Query" fields={query} />
      <FieldList
        title={op.bodyOptional ? "Body (optional)" : "Body"}
        fields={bodyFields}
      />
    </li>
  );
}

export default async function ApiDocsPage() {
  const origin = publicOrigin(await headers());
  const base = `${origin}/api/v1`;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API documentation</CardTitle>
          <CardDescription>
            The Clerq REST API at <Code>{base}</Code>. Machine-readable:{" "}
            <a className="underline" href="/api/v1/openapi.json">
              OpenAPI document
            </a>
            .
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            Create a key in Settings, API, and send it as a bearer token. A key
            works only in the business it was made in, acts as the person who
            made it with that person&apos;s permissions, and is either read
            only (GET only) or read and write. It stops working when it is
            revoked or its creator leaves the business.
          </p>
          <Example>{`curl -H "Authorization: Bearer clq_..." ${base}/health`}</Example>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            Send bodies as JSON objects. Dates are ISO 8601 strings
            (<Code>2026-12-01</Code> or <Code>2026-12-01T09:00:00Z</Code>).
            Money is in minor units (cents) with an ISO 4217 currency, except
            invoice and schedule lines, whose <Code>amountMajor</Code> is a
            decimal string such as <Code>&quot;1500.00&quot;</Code>.
          </p>
          <p>
            <Code>PATCH</Code> changes only the fields you send; <Code>null</Code>{" "}
            clears one, and a list is replaced as a whole. An id that doesn&apos;t
            exist, belongs to another business or isn&apos;t a UUID is a 404.
          </p>
          <Example>{`curl -X POST ${base}/clients \\
  -H "Authorization: Bearer clq_..." -H "Content-Type: application/json" \\
  -d '{"name": "Acme Ltd", "contacts": [{"name": "Jo", "email": "jo@acme.example"}]}'`}</Example>
          <Example>{`curl -X PATCH ${base}/tasks/<task id> \\
  -H "Authorization: Bearer clq_..." -H "Content-Type: application/json" \\
  -d '{"status": "done"}'`}</Example>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pagination</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            Lists answer <Code>{`{ "data": [...], "nextCursor": "..." }`}</Code>.
            Pass <Code>limit</Code> (1 to {MAX_PAGE_SIZE}, default{" "}
            {DEFAULT_PAGE_SIZE}) and, for the next page, <Code>cursor</Code>{" "}
            with the previous <Code>nextCursor</Code>. It is <Code>null</Code>{" "}
            on the last page.
          </p>
          <Example>{`curl -H "Authorization: Bearer clq_..." "${base}/clients?limit=100&cursor=<nextCursor>"`}</Example>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rate limits</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>
            {RATE_LIMIT_PER_MINUTE} requests a minute per key. Every response
            carries <Code>X-RateLimit-Limit</Code> and{" "}
            <Code>X-RateLimit-Remaining</Code>; a 429 carries{" "}
            <Code>Retry-After</Code> (seconds).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Errors</CardTitle>
          <CardDescription>
            Always JSON:{" "}
            <Code>{`{ "error": { "code": "not_found", "message": "..." } }`}</Code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm">
            {API_ERRORS.map((error) => (
              <li key={error.status}>
                <span className="font-mono text-xs font-semibold">{error.status}</span>{" "}
                <Code>{error.code}</Code>{" "}
                <span className="text-muted-foreground">{error.when}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {API_TAGS.map((tag) => {
        const ops = API_OPERATIONS.filter((op) => op.tag === tag.name);
        return (
          <Card key={tag.name}>
            <CardHeader>
              <CardTitle>{tag.name}</CardTitle>
              <CardDescription>{tag.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3">
                {ops.map((op) => (
                  <Endpoint key={`${op.method} ${op.path}`} op={op} />
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
