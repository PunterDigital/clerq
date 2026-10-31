import { z } from "zod";

import { clientInputSchema } from "@/modules/clients/service";
import {
  expenseInputSchema,
  expenseStatusSchema,
} from "@/modules/expenses/service";
import { projectInputSchema } from "@/modules/projects/service";
import {
  taskInputSchema,
  taskStatusSchema,
} from "@/modules/projects/tasks-service";
import { manualEntrySchema } from "@/modules/time/service";
import {
  draftInvoiceInputSchema,
  generateFromTimeSchema,
  invoiceDetailsSchema,
  lineInputSchema,
} from "@/server/trpc/routers/invoices";
import { recurringBodySchema } from "@/server/trpc/routers/recurring";

import { INVOICE_STATUSES } from "./invoices";
import { SCHEDULE_STATUSES } from "./recurring";
import {
  clientNoteBodySchema,
  expenseStatusBodySchema,
  invoiceNotesSchema,
  scheduleStatusBodySchema,
  taskStatusBodySchema,
  timeEntryNoteBodySchema,
  timerStartBodySchema,
  voidInvoiceBodySchema,
} from "./schemas";
import {
  DEFAULT_PAGE_SIZE,
  ERROR_CODE_BY_STATUS,
  MAX_PAGE_SIZE,
  RATE_LIMIT_PER_MINUTE,
} from "./v1";

// The OpenAPI 3.1 document for /api/v1, served at /api/v1/openapi.json and
// rendered by the docs page (Settings -> API -> API documentation). Request
// bodies are converted from the same Zod schemas the endpoints parse with, so
// the document can't drift from what the API accepts. openapi.test.ts fails
// when a route.ts under app/api/v1 has a handler that isn't listed here.

export type HttpMethod = "get" | "post" | "patch" | "delete";

export type QueryParam = {
  schema: z.ZodType;
  description: string;
  required?: boolean;
};

export type ApiOperation = {
  method: HttpMethod;
  // OpenAPI form, relative to /api/v1: "/clients/{clientId}".
  path: string;
  tag: string;
  summary: string;
  description?: string;
  query?: Record<string, QueryParam>;
  body?: z.ZodType;
  // POST bodies that may be left out entirely (void's reason).
  bodyOptional?: boolean;
  // A list answered as { data, nextCursor }, taking ?limit= and ?cursor=.
  paged?: boolean;
  // Answers 201 instead of 200.
  creates?: boolean;
  // When the record's state refuses it with a 409.
  conflict?: string;
  // Needs no API key.
  public?: boolean;
};

export const API_TAGS = [
  { name: "Health", description: "Check that a key works and which business it is for." },
  { name: "Clients", description: "Clients, their notes and activity." },
  { name: "Projects", description: "Projects belong to a client." },
  { name: "Tasks", description: "Tasks belong to a project." },
  {
    name: "Time",
    description:
      "Time entries and the timer. A key acts as the person who made it, so the timer and \"my\" time are that person's.",
  },
  {
    name: "Invoices",
    description:
      "Only a draft can be changed or deleted; an issued invoice can only be marked paid or voided.",
  },
  { name: "Recurring invoices", description: "Schedules (retainers) that generate invoices." },
  { name: "Expenses", description: "Business expenses. Receipts stay in the app." },
  { name: "Reference", description: "This document." },
] as const;

// A PATCH body: every field of the create schema, all optional. Built from
// the shape, since Zod refuses .partial() on a schema with refinements.
function patchOf(schema: { shape: z.ZodRawShape }) {
  return z.object(schema.shape).partial();
}

const { receipt: _receipt, ...expenseFields } = expenseInputSchema.shape;
void _receipt;
// The API refuses a receipt in an expense body (server/api/expenses.ts).
const expenseBodySchema = z.object(expenseFields);

const { invoiceId: _invoiceId, ...generateFields } = generateFromTimeSchema.shape;
void _invoiceId;
// generate-from-time takes the invoice id from the path.
const generateBodySchema = z.object(generateFields);

const uuid = z.string().uuid();
const isoDate = z.string();
const search = (what: string): QueryParam => ({
  schema: z.string(),
  description: `Only ${what} containing this text.`,
});

const DRAFT_ONLY = "The invoice is no longer a draft.";

export const API_OPERATIONS: ApiOperation[] = [
  // -- Health and reference
  {
    method: "get",
    path: "/health",
    tag: "Health",
    summary: "Check a key",
    description:
      "Confirms the key is valid, not revoked, within its rate limit and that its creator still belongs to the business. Answers with the business and key the request ran as.",
  },
  {
    method: "get",
    path: "/openapi.json",
    tag: "Reference",
    summary: "This OpenAPI document",
    public: true,
  },

  // -- Clients
  {
    method: "get",
    path: "/clients",
    tag: "Clients",
    summary: "List clients",
    description: "Newest first.",
    paged: true,
    query: {
      search: search("clients whose name is"),
      includeArchived: {
        schema: z.enum(["true", "false"]),
        description: "Include archived clients (default false).",
      },
    },
  },
  { method: "post", path: "/clients", tag: "Clients", summary: "Create a client", body: clientInputSchema, creates: true },
  { method: "get", path: "/clients/{clientId}", tag: "Clients", summary: "Get a client" },
  {
    method: "patch",
    path: "/clients/{clientId}",
    tag: "Clients",
    summary: "Change a client",
    description: "Fields left out keep their values; null clears one. contacts is replaced as a whole list.",
    body: patchOf(clientInputSchema),
  },
  { method: "post", path: "/clients/{clientId}/archive", tag: "Clients", summary: "Archive a client" },
  { method: "post", path: "/clients/{clientId}/unarchive", tag: "Clients", summary: "Bring an archived client back" },
  {
    method: "post",
    path: "/clients/{clientId}/notes",
    tag: "Clients",
    summary: "Add a note",
    description: "Adds a note to the client's activity thread.",
    body: clientNoteBodySchema,
    creates: true,
  },
  {
    method: "get",
    path: "/clients/{clientId}/activity",
    tag: "Clients",
    summary: "A client's activity",
    description: "Notes, changes and invoices, newest first.",
    paged: true,
  },

  // -- Projects
  {
    method: "get",
    path: "/projects",
    tag: "Projects",
    summary: "List projects",
    description: "With each project's client name.",
    paged: true,
    query: {
      clientId: { schema: uuid, description: "Only this client's projects." },
      search: search("projects whose name or client name is"),
    },
  },
  { method: "post", path: "/projects", tag: "Projects", summary: "Create a project", body: projectInputSchema, creates: true },
  { method: "get", path: "/projects/{projectId}", tag: "Projects", summary: "Get a project" },
  {
    method: "patch",
    path: "/projects/{projectId}",
    tag: "Projects",
    summary: "Change a project",
    description: "Fields left out keep their values; null clears one. clientId moves it to another client.",
    body: patchOf(projectInputSchema),
  },

  // -- Tasks
  {
    method: "get",
    path: "/tasks",
    tag: "Tasks",
    summary: "List tasks",
    description:
      "Pass projectId (a project's tasks, oldest first, with trackedSeconds) or search (across the business, newest first, with project and client names).",
    paged: true,
    query: {
      projectId: { schema: uuid, description: "A project's tasks." },
      search: search("tasks whose title is"),
      status: { schema: taskStatusSchema, description: "Only tasks with this status." },
    },
  },
  {
    method: "post",
    path: "/tasks",
    tag: "Tasks",
    summary: "Create a task",
    body: taskInputSchema.extend({ projectId: uuid }),
    creates: true,
  },
  { method: "get", path: "/tasks/{taskId}", tag: "Tasks", summary: "Get a task" },
  {
    method: "patch",
    path: "/tasks/{taskId}",
    tag: "Tasks",
    summary: "Change a task",
    description: "Fields left out keep their values.",
    body: patchOf(taskInputSchema),
  },
  {
    method: "delete",
    path: "/tasks/{taskId}",
    tag: "Tasks",
    summary: "Delete a task",
    description: "Deletes the task and its time entries.",
    conflict: "Some of the task's time is billed on an invoice.",
  },
  { method: "post", path: "/tasks/{taskId}/status", tag: "Tasks", summary: "Set a task's status", body: taskStatusBodySchema },

  // -- Time
  {
    method: "get",
    path: "/time-entries",
    tag: "Time",
    summary: "List time entries",
    description:
      "Pass taskId (everyone's entries on a task, newest first; needs permission to view all time), from and to (the key creator's own finished entries with startedAt in [from, to), oldest first), or both.",
    paged: true,
    query: {
      taskId: { schema: uuid, description: "Entries on this task." },
      from: { schema: isoDate, description: "ISO 8601 date or date-time; pass with to." },
      to: { schema: isoDate, description: "ISO 8601 date or date-time, exclusive; pass with from." },
    },
  },
  {
    method: "post",
    path: "/time-entries",
    tag: "Time",
    summary: "Log a manual entry",
    description: "Logged as the key's creator.",
    body: manualEntrySchema,
    creates: true,
  },
  {
    method: "patch",
    path: "/time-entries/{entryId}",
    tag: "Time",
    summary: "Change an entry's note",
    description: "The time itself can't be edited. null clears the note.",
    body: timeEntryNoteBodySchema,
  },
  { method: "delete", path: "/time-entries/{entryId}", tag: "Time", summary: "Delete an entry" },
  {
    method: "get",
    path: "/timer",
    tag: "Time",
    summary: "The running timer",
    description: '{ "timer": {...} }, or { "timer": null } when none runs.',
  },
  {
    method: "post",
    path: "/timer/start",
    tag: "Time",
    summary: "Start a timer",
    description: "A timer that is already running is stopped and saved first.",
    body: timerStartBodySchema,
    creates: true,
  },
  {
    method: "post",
    path: "/timer/stop",
    tag: "Time",
    summary: "Stop the timer",
    description: '{ "entry": {...} }, or { "entry": null } when nothing was running.',
  },

  // -- Invoices
  {
    method: "get",
    path: "/invoices",
    tag: "Invoices",
    summary: "List invoices",
    description: "Newest first, with client names.",
    paged: true,
    query: {
      status: { schema: z.enum(INVOICE_STATUSES), description: "Only invoices with this status." },
      clientId: { schema: uuid, description: "Only this client's invoices." },
      search: search("invoices whose number or client name is"),
    },
  },
  { method: "post", path: "/invoices", tag: "Invoices", summary: "Create a draft invoice", body: draftInvoiceInputSchema, creates: true },
  { method: "get", path: "/invoices/{invoiceId}", tag: "Invoices", summary: "Get an invoice", description: "With its lines." },
  {
    method: "patch",
    path: "/invoices/{invoiceId}",
    tag: "Invoices",
    summary: "Change a draft's dates or notes",
    description: "Send at least one field. Fields left out keep their values; null clears one.",
    body: z.object({ ...invoiceDetailsSchema.shape, ...invoiceNotesSchema.shape }).partial(),
    conflict: DRAFT_ONLY,
  },
  {
    method: "delete",
    path: "/invoices/{invoiceId}",
    tag: "Invoices",
    summary: "Delete a draft",
    description: "Its time goes back to unbilled.",
    conflict: "The invoice is issued: void it instead.",
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/lines",
    tag: "Invoices",
    summary: "Add a line to a draft",
    description: "A fixed-amount line. amountMajor is a decimal string in the invoice's currency. Answers with the invoice.",
    body: lineInputSchema,
    creates: true,
    conflict: DRAFT_ONLY,
  },
  {
    method: "patch",
    path: "/invoices/{invoiceId}/lines/{lineId}",
    tag: "Invoices",
    summary: "Change a draft line",
    description: "A new amount replaces the line's hours x rate breakdown. Answers with the invoice.",
    body: patchOf(lineInputSchema),
    conflict: DRAFT_ONLY,
  },
  {
    method: "delete",
    path: "/invoices/{invoiceId}/lines/{lineId}",
    tag: "Invoices",
    summary: "Remove a draft line",
    description: "Its time goes back to unbilled.",
    conflict: DRAFT_ONLY,
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/generate-from-time",
    tag: "Invoices",
    summary: "Fill a draft from unbilled time",
    description:
      "Adds lines from the client's unbilled billable time, or says why nothing was added (nothing_to_bill, missing_fx_rates).",
    body: generateBodySchema,
    conflict: DRAFT_ONLY,
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/issue",
    tag: "Invoices",
    summary: "Issue a draft",
    description: "Numbers the draft and marks it sent.",
    conflict: "The invoice is already issued, or a reverse-charge invoice lacks a VAT number.",
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/mark-paid",
    tag: "Invoices",
    summary: "Mark an invoice paid",
    conflict: "Only sent or overdue invoices can be marked paid.",
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/void",
    tag: "Invoices",
    summary: "Void an invoice",
    description: "It keeps its number; its time goes back to unbilled.",
    body: voidInvoiceBodySchema,
    bodyOptional: true,
    conflict: "Only sent or overdue invoices can be voided (delete a draft instead).",
  },
  {
    method: "post",
    path: "/invoices/{invoiceId}/duplicate",
    tag: "Invoices",
    summary: "Duplicate an invoice",
    description: "Copies any invoice into a new draft.",
    creates: true,
  },
  {
    method: "get",
    path: "/invoices/{invoiceId}/pdf-link",
    tag: "Invoices",
    summary: "A PDF download link",
    description: "A signed URL that downloads the PDF without a key or login, valid for 15 minutes.",
  },

  // -- Recurring invoices
  {
    method: "get",
    path: "/recurring-invoices",
    tag: "Recurring invoices",
    summary: "List recurring invoices",
    description: "With each schedule's client name and next run.",
    paged: true,
    query: { status: { schema: z.enum(SCHEDULE_STATUSES), description: "Only schedules with this status." } },
  },
  {
    method: "post",
    path: "/recurring-invoices",
    tag: "Recurring invoices",
    summary: "Create a recurring invoice",
    body: recurringBodySchema,
    creates: true,
  },
  { method: "get", path: "/recurring-invoices/{scheduleId}", tag: "Recurring invoices", summary: "Get a recurring invoice" },
  {
    method: "patch",
    path: "/recurring-invoices/{scheduleId}",
    tag: "Recurring invoices",
    summary: "Change a recurring invoice",
    description: "Fields left out keep their values; lines is replaced as a whole list. Invoices already generated don't change.",
    body: patchOf(recurringBodySchema),
  },
  {
    method: "delete",
    path: "/recurring-invoices/{scheduleId}",
    tag: "Recurring invoices",
    summary: "Delete a recurring invoice",
    description: "The invoices it generated stay.",
  },
  {
    method: "get",
    path: "/recurring-invoices/{scheduleId}/invoices",
    tag: "Recurring invoices",
    summary: "Invoices it generated",
    paged: true,
  },
  {
    method: "post",
    path: "/recurring-invoices/{scheduleId}/status",
    tag: "Recurring invoices",
    summary: "Pause, resume or end",
    body: scheduleStatusBodySchema,
  },
  {
    method: "post",
    path: "/recurring-invoices/{scheduleId}/generate",
    tag: "Recurring invoices",
    summary: "Generate the next invoice now",
    conflict: "The schedule isn't active.",
  },

  // -- Expenses
  {
    method: "get",
    path: "/expenses",
    tag: "Expenses",
    summary: "List expenses",
    description: "Newest first.",
    paged: true,
    query: {
      status: { schema: expenseStatusSchema, description: "Only expenses with this status." },
      from: { schema: isoDate, description: "incurredAt on or after this ISO 8601 date." },
      to: { schema: isoDate, description: "incurredAt before this ISO 8601 date." },
      search: search("expenses whose description, vendor or category is"),
    },
  },
  {
    method: "post",
    path: "/expenses",
    tag: "Expenses",
    summary: "Create an expense",
    description: "Receipts are added in the app; a body with receipt is a 422.",
    body: expenseBodySchema,
    creates: true,
  },
  {
    method: "get",
    path: "/expenses/{expenseId}",
    tag: "Expenses",
    summary: "Get an expense",
    description: "Without the receipt file; receiptFilename says whether it has one.",
  },
  {
    method: "patch",
    path: "/expenses/{expenseId}",
    tag: "Expenses",
    summary: "Change an expense",
    description: "Fields left out, and any receipt, keep their values.",
    body: patchOf(expenseBodySchema),
  },
  { method: "delete", path: "/expenses/{expenseId}", tag: "Expenses", summary: "Delete an expense", description: "And its receipt." },
  { method: "post", path: "/expenses/{expenseId}/status", tag: "Expenses", summary: "Mark paid or unpaid", body: expenseStatusBodySchema },
];

// -- Conversion -----------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

// A Zod schema as the JSON Schema a caller sends (io: "input", so fields with
// a default are optional). JSON has no dates: z.date() fields are the ISO 8601
// strings dateField() turns into Dates.
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.description = "ISO 8601 date or date-time, e.g. 2026-12-01";
      }
    },
  });
  void _dialect;
  return rest as JsonSchema;
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

const ERROR_RESPONSES = {
  BadRequest: [400, "The request body isn't JSON."],
  Unauthorized: [401, "No key, an unknown or revoked key, or its creator left the business."],
  Forbidden: [403, "The key is read only, or its creator lacks the permission."],
  NotFound: [404, "No such record (or it belongs to another business)."],
  Conflict: [409, "The record's state doesn't allow it."],
  ValidationFailed: [422, "Invalid input, limit or cursor. The message starts with the field."],
  RateLimited: [429, "Over the key's rate limit; see Retry-After."],
} as const;

type ErrorResponseName = keyof typeof ERROR_RESPONSES;

// The error table on the docs page.
export const API_ERRORS = Object.values(ERROR_RESPONSES).map(([status, when]) => ({
  status,
  code: ERROR_CODE_BY_STATUS[status] ?? "error",
  when,
}));

const ref = (name: ErrorResponseName) => ({ $ref: `#/components/responses/${name}` });

function operationObject(op: ApiOperation) {
  const parameters: unknown[] = pathParams(op.path).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
  for (const [name, param] of Object.entries(op.query ?? {})) {
    parameters.push({
      name,
      in: "query",
      required: param.required ?? false,
      description: param.description,
      schema: toJsonSchema(param.schema),
    });
  }
  if (op.paged) {
    parameters.push(
      {
        name: "limit",
        in: "query",
        required: false,
        description: `Page size, 1 to ${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`,
        schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "The previous page's nextCursor.",
        schema: { type: "string" },
      },
    );
  }

  const success = op.paged
    ? { $ref: "#/components/schemas/Page" }
    : { type: "object" };
  const responses: Record<string, unknown> = {
    [op.creates ? "201" : "200"]: {
      description: op.creates ? "Created" : "OK",
      content: { "application/json": { schema: success } },
    },
  };
  if (!op.public) {
    responses["401"] = ref("Unauthorized");
    responses["403"] = ref("Forbidden");
    responses["429"] = ref("RateLimited");
  }
  if (pathParams(op.path).length > 0) responses["404"] = ref("NotFound");
  if (op.conflict) {
    responses["409"] = {
      description: op.conflict,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  if (op.body) responses["400"] = ref("BadRequest");
  if (op.body || op.query || op.paged) responses["422"] = ref("ValidationFailed");

  return {
    operationId: operationId(op),
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.public ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: !op.bodyOptional,
            content: { "application/json": { schema: toJsonSchema(op.body) } },
          },
        }
      : {}),
    responses,
  };
}

// get /clients/{clientId}/activity -> getClientsActivity
export function operationId(op: ApiOperation): string {
  const words = op.path
    .split("/")
    .filter((part) => part && !part.startsWith("{"))
    .flatMap((part) => part.split(/[-.]/));
  const byId = op.path.endsWith("}") ? "ById" : "";
  return (
    op.method +
    words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") +
    byId
  );
}

// The address callers reach this instance on: behind a proxy (Easypanel,
// Coolify) the request URL is the container's own, so prefer the forwarded
// host.
export function publicOrigin(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "app.useclerq.net";
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

// `origin` is the instance's own address, so a self-hosted Clerq documents
// itself.
export function buildOpenApiDocument(origin: string, version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    (paths[op.path] ??= {})[op.method] = operationObject(op);
  }
  const errorSchema = { $ref: "#/components/schemas/Error" };
  return {
    openapi: "3.1.0",
    info: {
      title: "Clerq REST API",
      version,
      description:
        `Every endpoint acts in one business as the person who created the API key, with that person's permissions. ` +
        `Rate limit: ${RATE_LIMIT_PER_MINUTE} requests a minute per key. ` +
        "Money is in minor units with an ISO 4217 currency, except invoice and schedule line amounts (amountMajor, a decimal string).",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: API_TAGS.map((tag) => ({ ...tag })),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "A clq_ key from Settings -> API, sent as Authorization: Bearer clq_...",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Object.values(ERROR_CODE_BY_STATUS) },
                message: { type: "string" },
              },
            },
          },
        },
        Page: {
          type: "object",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: { type: "object" } },
            nextCursor: {
              type: ["string", "null"],
              description: "Pass as ?cursor= for the next page; null on the last page.",
            },
          },
        },
      },
      responses: Object.fromEntries(
        Object.entries(ERROR_RESPONSES).map(([name, [, description]]) => [
          name,
          { description, content: { "application/json": { schema: errorSchema } } },
        ]),
      ),
    },
  };
}
