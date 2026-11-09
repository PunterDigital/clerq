import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ClerqCaller } from "./caller";
import { signInvoicePdfToken } from "./pdf-link";
import { runTool, toolJson } from "./result";

// Reused description fragments. The model gets money and dates wrong unless
// the units are spelled out at every field, so these are not optional polish.
const MINOR =
  "Amount in minor currency units (e.g. cents): 1250 means 12.50. Integer only.";
const CURRENCY = "ISO 4217 currency code, e.g. EUR or USD.";
const ISO = "ISO 8601 timestamp, e.g. 2026-06-12T09:00:00Z.";

const currencyField = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Three-letter ISO 4217 code")
  .describe(CURRENCY);

// hour|day, optional - the service defaults absent values to "hour".
const rateUnitField = z.enum(["hour", "day"]).optional();

const contactField = z.object({
  name: z.string().describe("Contact's full name."),
  email: z.string().email().optional(),
  role: z.string().optional().describe("e.g. Billing, Primary, Technical."),
});

// Shared shape for create/update client. Mirrors clientInputSchema; the caller
// re-validates, so this is the model-facing surface, not the source of truth.
const clientFields = {
  name: z
    .string()
    .describe("Client display name - the company or organisation you invoice."),
  contacts: z.array(contactField).optional().describe("People at the client."),
  notes: z.string().optional().describe("Freeform notes about the client."),
  address: z
    .string()
    .nullable()
    .optional()
    .describe("Postal address, newline-separated; printed on invoices."),
  companyNumber: z
    .string()
    .nullable()
    .optional()
    .describe("Company / registration number (Companies House, IČO, etc.)."),
  vatNumber: z
    .string()
    .nullable()
    .optional()
    .describe("VAT number; required at issue time for reverse-charge invoices."),
  defaultRateMinor: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      `Default rate used when the owner works the client solo. ${MINOR} Per the unit in defaultRateUnit.`,
    ),
  defaultRateCurrency: currencyField.nullable().optional(),
  defaultRateUnit: rateUnitField.describe(
    'Whether defaultRateMinor is per "hour" or per "day". Defaults to hour; a day rate is divided by the business hours-per-day into an effective hourly rate.',
  ),
  budgetMinor: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(`Optional overall budget for the client engagement. ${MINOR}`),
  budgetCurrency: currencyField.nullable().optional(),
};

const taskStatus = z
  .enum(["todo", "in_progress", "in_review", "done"])
  .describe("Task status.");

const scheduleLineField = z.object({
  description: z
    .string()
    .min(1)
    .max(500)
    .describe('Line description, e.g. "Monthly retainer".'),
  amountMajor: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .describe(
      'Fixed amount in MAJOR units as a decimal string, e.g. "1500" or "1500.00" (NOT minor units).',
    ),
});

// The model-facing surface for a recurring invoice (retainer). Mirrors the
// recurring router's body schema; the caller re-validates, so this is guidance,
// not the source of truth. Shared by create and update (which replaces the
// whole schedule wholesale).
const scheduleFields = {
  clientId: z.string().uuid(),
  projectId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Optional project to attribute the generated invoices to."),
  name: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Internal label for the schedule, e.g. "Acme monthly retainer". Not printed on the invoices.',
    ),
  currency: currencyField,
  taxTreatment: z
    .enum(["standard", "zero_rated", "reverse_charge"])
    .describe(
      "Tax treatment applied to every generated invoice. Standard requires a standard VAT rate set in settings; reverse_charge needs both business and client VAT numbers to auto-issue.",
    ),
  frequency: z
    .enum(["weekly", "monthly", "quarterly", "yearly"])
    .describe("Cadence unit."),
  interval: z
    .number()
    .int()
    .min(1)
    .max(52)
    .describe(
      "Repeat every N frequency units (e.g. frequency=weekly, interval=2 is fortnightly).",
    ),
  startDate: z
    .string()
    .datetime()
    .describe(`Date of the first invoice; the series steps out from here. ${ISO}`),
  endDate: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe(`Optional stop date - nothing generates past it. ${ISO}`),
  occurrenceLimit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .nullable()
    .optional()
    .describe("Optional cap on how many invoices this schedule ever generates."),
  netTermsDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .describe("Days after each invoice's date that it falls due. 0 means due on issue."),
  autoIssue: z
    .boolean()
    .describe(
      "When true, each generated invoice is issued (numbered and marked sent) automatically; when false it is left as a draft to review.",
    ),
  notes: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Optional notes printed at the foot of every generated invoice."),
  lines: z
    .array(scheduleLineField)
    .min(1)
    .max(50)
    .describe("Fixed-amount lines stamped onto every generated invoice."),
};

export type ClerqMcpOptions = {
  caller: ClerqCaller;
  /** Active business of the authenticated user; used to sign PDF links. */
  businessId: string;
  /** Absolute origin of this deployment, e.g. https://app.example.com. */
  baseUrl: string;
};

// Builds the Clerq MCP server for one authenticated request. Every tool is a
// thin adapter: validate the model's args, call the matching tRPC procedure,
// hand the result back as JSON. Errors become readable isError results via
// runTool rather than throwing.
export function createClerqMcpServer(opts: ClerqMcpOptions): McpServer {
  const { caller, businessId, baseUrl } = opts;
  const server = new McpServer({ name: "clerq", version: "1.0.0" });

  // --- Connectivity -------------------------------------------------------
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the authenticated user's active business (id, name, currency). Use to confirm the connection works.",
    },
    () => runTool(async () => toolJson(await caller.business.current())),
  );

  // --- Clients ------------------------------------------------------------
  server.registerTool(
    "list_clients",
    {
      title: "List clients",
      description: "List clients for the active business.",
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived clients (default false)."),
      },
    },
    ({ includeArchived }) =>
      runTool(async () =>
        toolJson(await caller.clients.list({ includeArchived })),
      ),
  );

  server.registerTool(
    "get_client",
    {
      title: "Get client",
      description: "Fetch a single client by id.",
      inputSchema: { clientId: z.string().uuid() },
    },
    ({ clientId }) =>
      runTool(async () => toolJson(await caller.clients.get({ clientId }))),
  );

  server.registerTool(
    "create_client",
    {
      title: "Create client",
      description: "Create a new client.",
      inputSchema: clientFields,
    },
    (args) =>
      runTool(async () => toolJson(await caller.clients.create(args))),
  );

  server.registerTool(
    "update_client",
    {
      title: "Update client",
      description:
        "Replace a client's details. All fields are overwritten, so pass the full intended state.",
      inputSchema: { clientId: z.string().uuid(), ...clientFields },
    },
    ({ clientId, ...data }) =>
      runTool(async () =>
        toolJson(await caller.clients.update({ clientId, data })),
      ),
  );

  server.registerTool(
    "set_client_contacts",
    {
      title: "Set client contacts",
      description:
        "Replace the contact list on a client without touching its other fields.",
      inputSchema: {
        clientId: z.string().uuid(),
        contacts: z.array(contactField),
      },
    },
    ({ clientId, contacts }) =>
      runTool(async () => {
        const existing = await caller.clients.get({ clientId });
        const updated = await caller.clients.update({
          clientId,
          data: {
            name: existing.name,
            contacts,
            notes: existing.notes ?? undefined,
            address: existing.address,
            companyNumber: existing.companyNumber,
            vatNumber: existing.vatNumber,
            defaultRateMinor: existing.defaultRateMinor,
            defaultRateCurrency: existing.defaultRateCurrency,
            defaultRateUnit: existing.defaultRateUnit,
            budgetMinor: existing.budgetMinor,
            budgetCurrency: existing.budgetCurrency,
          },
        });
        return toolJson(updated);
      }),
  );

  server.registerTool(
    "add_client_note",
    {
      title: "Add client note",
      description:
        "Append a timestamped note to a client's activity thread. Does not replace existing notes.",
      inputSchema: {
        clientId: z.string().uuid(),
        text: z.string().min(1).describe("Note body."),
      },
    },
    ({ clientId, text }) =>
      runTool(async () =>
        toolJson(await caller.clients.addNote({ clientId, text })),
      ),
  );

  server.registerTool(
    "get_client_activity",
    {
      title: "Get client activity",
      description: "List the activity thread (notes and lifecycle events) for a client.",
      inputSchema: { clientId: z.string().uuid() },
    },
    ({ clientId }) =>
      runTool(async () => toolJson(await caller.clients.activity({ clientId }))),
  );

  server.registerTool(
    "archive_client",
    {
      title: "Archive client",
      description: "Archive a client (soft; reversible with unarchive_client).",
      inputSchema: { clientId: z.string().uuid() },
    },
    ({ clientId }) =>
      runTool(async () => toolJson(await caller.clients.archive({ clientId }))),
  );

  server.registerTool(
    "unarchive_client",
    {
      title: "Unarchive client",
      description: "Restore a previously archived client.",
      inputSchema: { clientId: z.string().uuid() },
    },
    ({ clientId }) =>
      runTool(async () =>
        toolJson(await caller.clients.unarchive({ clientId })),
      ),
  );

  server.registerTool(
    "list_client_member_rates",
    {
      title: "List client member rates",
      description:
        "List the per-client bill rates for team members on a client. Internal cost fields are included only if you have permission to view profit.",
      inputSchema: { clientId: z.string().uuid() },
    },
    ({ clientId }) =>
      runTool(async () =>
        toolJson(await caller.clients.listMemberRates({ clientId })),
      ),
  );

  server.registerTool(
    "set_client_member_rate",
    {
      title: "Set client member rate",
      description:
        "Set (or update) a team member's bill rate, optional internal cost and optional budget on a client. Keyed by (client, user); re-setting overwrites. Internal cost is only stored if you can view profit.",
      inputSchema: {
        clientId: z.string().uuid(),
        userId: z.string().describe("The team member's user id."),
        billRateMinor: z.number().int().nonnegative().describe(`Bill rate. ${MINOR}`),
        billRateCurrency: currencyField,
        billRateUnit: rateUnitField.describe('Per "hour" or "day". Defaults to hour.'),
        internalCostMinor: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe(`What the business pays the member (their cost). ${MINOR}`),
        internalCostCurrency: currencyField.nullable().optional(),
        internalCostUnit: rateUnitField,
        budgetMinor: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe(`Optional budget for this member on the client. ${MINOR}`),
        budgetCurrency: currencyField.nullable().optional(),
      },
    },
    ({ clientId, ...data }) =>
      runTool(async () =>
        toolJson(await caller.clients.setMemberRate({ clientId, data })),
      ),
  );

  server.registerTool(
    "remove_client_member_rate",
    {
      title: "Remove client member rate",
      description: "Remove a team member's rate from a client.",
      inputSchema: { clientId: z.string().uuid(), userId: z.string() },
    },
    ({ clientId, userId }) =>
      runTool(async () =>
        toolJson(await caller.clients.removeMemberRate({ clientId, userId })),
      ),
  );

  // --- Projects -----------------------------------------------------------
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List projects, optionally filtered to one client.",
      inputSchema: {
        clientId: z.string().uuid().optional().describe("Filter to this client."),
      },
    },
    ({ clientId }) =>
      runTool(async () => toolJson(await caller.projects.list({ clientId }))),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Fetch a single project by id.",
      inputSchema: { projectId: z.string().uuid() },
    },
    ({ projectId }) =>
      runTool(async () => toolJson(await caller.projects.get({ projectId }))),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a project for a client.",
      inputSchema: {
        name: z.string().describe("Project name."),
        clientId: z.string().uuid().describe("Owning client."),
        status: z
          .enum(["active", "on_hold", "completed"])
          .optional()
          .describe("Defaults to active."),
        dueDate: z.string().datetime().nullable().optional().describe(ISO),
        defaultRateMinor: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe(`Overrides the client rate. ${MINOR}`),
        defaultRateCurrency: currencyField.nullable().optional(),
        defaultRateUnit: rateUnitField.describe(
          'Whether defaultRateMinor is per "hour" or per "day". Defaults to hour.',
        ),
        budgetMinor: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe(`Optional budget for this project. ${MINOR}`),
        budgetCurrency: currencyField.nullable().optional(),
      },
    },
    ({ dueDate, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.projects.create({
            ...rest,
            dueDate: dueDate ? new Date(dueDate) : null,
          }),
        ),
      ),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description:
        "Replace a project's details. All fields are overwritten, so pass the full intended state.",
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string(),
        clientId: z.string().uuid(),
        status: z.enum(["active", "on_hold", "completed"]).optional(),
        dueDate: z.string().datetime().nullable().optional().describe(ISO),
        defaultRateMinor: z.number().int().nonnegative().nullable().optional(),
        defaultRateCurrency: currencyField.nullable().optional(),
        defaultRateUnit: rateUnitField,
        budgetMinor: z.number().int().nonnegative().nullable().optional(),
        budgetCurrency: currencyField.nullable().optional(),
      },
    },
    ({ projectId, dueDate, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.projects.update({
            projectId,
            data: { ...rest, dueDate: dueDate ? new Date(dueDate) : null },
          }),
        ),
      ),
  );

  // --- Tasks --------------------------------------------------------------
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks for a project, including tracked seconds per task.",
      inputSchema: { projectId: z.string().uuid() },
    },
    ({ projectId }) =>
      runTool(async () => toolJson(await caller.tasks.list({ projectId }))),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Add a task to a project.",
      inputSchema: {
        projectId: z.string().uuid(),
        title: z.string().describe("Task title."),
        status: taskStatus.optional().describe("Defaults to todo."),
        estimateMinutes: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .nullable()
          .optional()
          .describe("Estimate in minutes."),
      },
    },
    ({ projectId, ...data }) =>
      runTool(async () =>
        toolJson(await caller.tasks.create({ projectId, data })),
      ),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description: "Replace a task's title, status and estimate.",
      inputSchema: {
        taskId: z.string().uuid(),
        title: z.string(),
        status: taskStatus.optional(),
        estimateMinutes: z.number().int().positive().max(60_000).nullable().optional(),
      },
    },
    ({ taskId, ...data }) =>
      runTool(async () => toolJson(await caller.tasks.update({ taskId, data }))),
  );

  server.registerTool(
    "set_task_status",
    {
      title: "Set task status",
      description: "Move a task to a new status.",
      inputSchema: { taskId: z.string().uuid(), status: taskStatus },
    },
    ({ taskId, status }) =>
      runTool(async () =>
        toolJson(await caller.tasks.setStatus({ taskId, status })),
      ),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description:
        "Delete a task and its tracked time entries. This is permanent. Refused while any of the task's time is billed on an invoice line - release the time first (remove the draft's lines, delete the draft, or void the issued invoice).",
      inputSchema: { taskId: z.string().uuid() },
    },
    ({ taskId }) =>
      runTool(async () => toolJson(await caller.tasks.delete({ taskId }))),
  );

  // --- Time tracking ------------------------------------------------------
  server.registerTool(
    "get_running_timer",
    {
      title: "Get running timer",
      description: "Return the caller's currently running timer, or null if none.",
    },
    () => runTool(async () => toolJson(await caller.time.running())),
  );

  server.registerTool(
    "start_timer",
    {
      title: "Start timer",
      description:
        "Start a timer on a task for the authenticated user. Stops any timer already running.",
      inputSchema: { taskId: z.string().uuid() },
    },
    ({ taskId }) =>
      runTool(async () => toolJson(await caller.time.start({ taskId }))),
  );

  server.registerTool(
    "stop_timer",
    {
      title: "Stop timer",
      description:
        "Stop the caller's running timer. No-op (returns null) if nothing is running.",
    },
    () => runTool(async () => toolJson(await caller.time.stop())),
  );

  server.registerTool(
    "log_time",
    {
      title: "Log time manually",
      description: "Log a completed time entry on a task.",
      inputSchema: {
        taskId: z.string().uuid(),
        startedAt: z.string().datetime().describe(`When the work started. ${ISO}`),
        durationSeconds: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 3600)
          .describe("Duration in seconds (max 7 days)."),
        billable: z.boolean().optional().describe("Defaults to true."),
        note: z.string().optional(),
        rateMinor: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe(`Override the resolved rate. ${MINOR}`),
        rateCurrency: currencyField.nullable().optional(),
      },
    },
    ({ startedAt, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.time.logManual({
            ...rest,
            startedAt: new Date(startedAt),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_task_time",
    {
      title: "List task time entries",
      description: "List all time entries logged against a task.",
      inputSchema: { taskId: z.string().uuid() },
    },
    ({ taskId }) =>
      runTool(async () => toolJson(await caller.time.listForTask({ taskId }))),
  );

  server.registerTool(
    "update_time_note",
    {
      title: "Update time entry note",
      description: "Set or clear the note on a time entry (pass null to clear).",
      inputSchema: {
        entryId: z.string().uuid(),
        note: z.string().nullable(),
      },
    },
    ({ entryId, note }) =>
      runTool(async () =>
        toolJson(await caller.time.updateNote({ entryId, note })),
      ),
  );

  // --- Invoices -----------------------------------------------------------
  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description: "List invoices for the active business with client names.",
    },
    () => runTool(async () => toolJson(await caller.invoices.list())),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description: "Fetch an invoice with its line items.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () => toolJson(await caller.invoices.get({ invoiceId }))),
  );

  server.registerTool(
    "create_draft_invoice",
    {
      title: "Create draft invoice",
      description:
        "Create a draft invoice for a client. Standard tax treatment requires a standard VAT rate set in settings.",
      inputSchema: {
        clientId: z.string().uuid(),
        projectId: z.string().uuid().optional(),
        currency: currencyField,
        taxTreatment: z
          .enum(["standard", "zero_rated", "reverse_charge"])
          .describe("Tax treatment for the whole invoice."),
        issueDate: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(
            `The issue date used (and printed) when this draft is issued - set this to backdate an invoice (e.g. a client paid before one existed). Omit or leave null to issue at today's date. ${ISO}`,
          ),
        dueDate: z.string().datetime().nullable().optional().describe(ISO),
        periodStart: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(
            `Start of the billing period this invoice covers. ${ISO} Set both period ends or neither.`,
          ),
        periodEnd: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(`End of the billing period this invoice covers. ${ISO}`),
      },
    },
    ({ issueDate, dueDate, periodStart, periodEnd, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.invoices.createDraft({
            ...rest,
            issueDate: issueDate ? new Date(issueDate) : null,
            dueDate: dueDate ? new Date(dueDate) : null,
            periodStart: periodStart ? new Date(periodStart) : null,
            periodEnd: periodEnd ? new Date(periodEnd) : null,
          }),
        ),
      ),
  );

  server.registerTool(
    "generate_invoice_from_time",
    {
      title: "Generate invoice lines from time",
      description:
        "Fill a draft invoice with lines built from unbilled, billable time. Groups by person+rate, by task, or into a single line. A nothing_to_bill result includes details explaining where the client's time is (already billed on which invoice, unpriced, timers still running). If entries carry rates in other currencies than the invoice's, the result lists them as missing_fx_rates - retry with fxRates supplying a conversion rate per currency.",
      inputSchema: {
        invoiceId: z.string().uuid(),
        projectId: z.string().uuid().optional().describe("Limit to one project."),
        grouping: z.enum(["person_rate", "task", "single"]),
        includeTaskList: z.boolean().optional(),
        replace: z
          .boolean()
          .optional()
          .describe(
            "Clear the draft's previously generated lines first (their time returns to the pool and is regenerated with the new grouping). Manual fixed-amount lines are kept. Use to redo a generation whose grouping was wrong.",
          ),
        fxRates: z
          .record(
            z.string().regex(/^[A-Z]{3}$/),
            z.object({
              rate: z
                .string()
                .regex(/^\d+(\.\d+)?$/)
                .describe("Units of the invoice currency per 1 unit of this currency, as a decimal string."),
              source: z.enum(["ecb", "manual"]),
            }),
          )
          .optional()
          .describe(
            "Conversion rates keyed by source currency code, required when entries carry rates in other currencies than the invoice's. Confirm rates with the user before applying - they are stored on the invoice lines.",
          ),
      },
    },
    (args) =>
      runTool(async () =>
        toolJson(await caller.invoices.generateFromTime(args)),
      ),
  );

  server.registerTool(
    "add_invoice_line",
    {
      title: "Add fixed-amount invoice line",
      description:
        "Add a manual fixed-amount line to a draft invoice. Amount is a plain decimal string in major units, e.g. \"1500\" or \"1500.00\".",
      inputSchema: {
        invoiceId: z.string().uuid(),
        description: z.string().min(1),
        amountMajor: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Major units as a decimal string, e.g. 1500.00 (not cents)."),
      },
    },
    (args) =>
      runTool(async () => toolJson(await caller.invoices.addLine(args))),
  );

  server.registerTool(
    "update_invoice_line",
    {
      title: "Edit an invoice line",
      description:
        "Edit a line on a draft invoice: its description and amount. Amount is a plain decimal string in major units, e.g. \"1500\" or \"1500.00\". Changing the amount replaces any hours x rate breakdown on the line with the amount you set. Draft invoices only.",
      inputSchema: {
        lineId: z.string().uuid(),
        description: z.string().min(1),
        amountMajor: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Major units as a decimal string, e.g. 1500.00 (not cents)."),
      },
    },
    (args) =>
      runTool(async () => toolJson(await caller.invoices.updateLine(args))),
  );

  server.registerTool(
    "set_invoice_details",
    {
      title: "Set invoice dates",
      description:
        "Set the dated metadata of a draft invoice: the issue date (used and printed when it is issued - omit to issue at today's date), the due date, and the optional billing period. Each field replaces the current value; pass null to clear. Set both billing-period ends together or neither. Draft invoices only.",
      inputSchema: {
        invoiceId: z.string().uuid(),
        issueDate: z.string().datetime().nullable().optional().describe(ISO),
        dueDate: z.string().datetime().nullable().optional().describe(ISO),
        periodStart: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(`Start of the billing period. ${ISO} Set both ends or neither.`),
        periodEnd: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(`End of the billing period. ${ISO}`),
      },
    },
    ({ invoiceId, issueDate, dueDate, periodStart, periodEnd }) =>
      runTool(async () =>
        toolJson(
          await caller.invoices.updateDetails({
            invoiceId,
            issueDate: issueDate ? new Date(issueDate) : null,
            dueDate: dueDate ? new Date(dueDate) : null,
            periodStart: periodStart ? new Date(periodStart) : null,
            periodEnd: periodEnd ? new Date(periodEnd) : null,
          }),
        ),
      ),
  );

  server.registerTool(
    "set_invoice_notes",
    {
      title: "Set invoice notes",
      description:
        "Set the free-text notes printed at the foot of a draft invoice (just above the footer). Replaces any existing notes; pass an empty string to clear them. Draft invoices only.",
      inputSchema: {
        invoiceId: z.string().uuid(),
        notes: z
          .string()
          .max(2000)
          .describe("Free-text notes. Empty string clears them."),
      },
    },
    ({ invoiceId, notes }) =>
      runTool(async () =>
        toolJson(await caller.invoices.setNotes({ invoiceId, notes })),
      ),
  );

  server.registerTool(
    "issue_invoice",
    {
      title: "Issue invoice",
      description:
        "Issue a draft invoice: assigns the next sequential number and marks it sent. Irreversible.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () => toolJson(await caller.invoices.issue({ invoiceId }))),
  );

  server.registerTool(
    "mark_invoice_paid",
    {
      title: "Mark invoice paid",
      description: "Mark an issued invoice as paid.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () =>
        toolJson(await caller.invoices.markPaid({ invoiceId })),
      ),
  );

  server.registerTool(
    "void_invoice",
    {
      title: "Void invoice",
      description:
        "Void a sent or overdue invoice (e.g. to re-issue a corrected copy). The invoice keeps its number but no longer counts as revenue, and any time billed on it returns to the unbilled pool so it can be billed again. Only sent/overdue invoices can be voided; paid is locked and drafts are edited. Optionally record a reason.",
      inputSchema: {
        invoiceId: z.string().uuid(),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe("Why it was voided, e.g. \"client address changed\"."),
      },
    },
    ({ invoiceId, reason }) =>
      runTool(async () =>
        toolJson(await caller.invoices.void({ invoiceId, reason })),
      ),
  );

  server.registerTool(
    "duplicate_invoice",
    {
      title: "Duplicate invoice",
      description:
        "Copy an invoice into a new editable draft with the same client, currency, tax setup and lines. The copy has no number or issue date and its lines are detached from the source's time entries.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () =>
        toolJson(await caller.invoices.duplicate({ invoiceId })),
      ),
  );

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete draft invoice",
      description:
        "Permanently delete a draft invoice. Only drafts can be deleted - issued invoices are kept (void them instead). Any time entries billed on the draft are released back to the unbilled pool.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () =>
        toolJson(await caller.invoices.delete({ invoiceId })),
      ),
  );

  // --- Recurring invoices -------------------------------------------------
  server.registerTool(
    "list_recurring_invoices",
    {
      title: "List recurring invoices",
      description:
        "List the recurring invoices (retainers) for the active business, each with its client, cadence, next run date, status and template total.",
    },
    () => runTool(async () => toolJson(await caller.recurring.list())),
  );

  server.registerTool(
    "get_recurring_invoice",
    {
      title: "Get recurring invoice",
      description:
        "Fetch a single recurring invoice by id, with its template lines, cadence, tax setup and stop conditions.",
      inputSchema: { scheduleId: z.string().uuid() },
    },
    ({ scheduleId }) =>
      runTool(async () => toolJson(await caller.recurring.get({ scheduleId }))),
  );

  server.registerTool(
    "list_recurring_invoice_history",
    {
      title: "List a recurring invoice's generated invoices",
      description:
        "List the invoices a recurring invoice has already generated, newest first.",
      inputSchema: { scheduleId: z.string().uuid() },
    },
    ({ scheduleId }) =>
      runTool(async () =>
        toolJson(await caller.recurring.generated({ scheduleId })),
      ),
  );

  server.registerTool(
    "create_recurring_invoice",
    {
      title: "Create recurring invoice",
      description:
        "Create a recurring invoice (retainer): a template plus a cadence. Clerq drafts a new invoice each time it comes due, dated at the occurrence and due after the net terms. Standard tax treatment requires a standard VAT rate set in settings.",
      inputSchema: scheduleFields,
    },
    ({ startDate, endDate, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.recurring.create({
            ...rest,
            startDate: new Date(startDate),
            endDate: endDate ? new Date(endDate) : null,
          }),
        ),
      ),
  );

  server.registerTool(
    "update_recurring_invoice",
    {
      title: "Update recurring invoice",
      description:
        "Replace a recurring invoice's template and cadence wholesale: send the COMPLETE set of fields and lines, not just the ones you want to change (omitted lines are dropped). Fetch it first with get_recurring_invoice if unsure. Cadence changes apply from the schedule's current place in the series.",
      inputSchema: { scheduleId: z.string().uuid(), ...scheduleFields },
    },
    ({ scheduleId, startDate, endDate, ...rest }) =>
      runTool(async () =>
        toolJson(
          await caller.recurring.update({
            scheduleId,
            data: {
              ...rest,
              startDate: new Date(startDate),
              endDate: endDate ? new Date(endDate) : null,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "set_recurring_invoice_status",
    {
      title: "Pause, resume or end a recurring invoice",
      description:
        'Change a recurring invoice\'s status. "paused" stops generation; resuming with "active" skips past any occurrences missed while paused (never back-bills). "ended" is terminal - it stops the schedule for good. Invoices already generated are always kept.',
      inputSchema: {
        scheduleId: z.string().uuid(),
        status: z.enum(["active", "paused", "ended"]),
      },
    },
    ({ scheduleId, status }) =>
      runTool(async () =>
        toolJson(await caller.recurring.setStatus({ scheduleId, status })),
      ),
  );

  server.registerTool(
    "generate_recurring_invoice_now",
    {
      title: "Generate the next recurring invoice now",
      description:
        "Generate the next scheduled invoice immediately instead of waiting for the sweep; the schedule then advances as usual. Returns how many invoices were generated and whether auto-issue succeeded.",
      inputSchema: { scheduleId: z.string().uuid() },
    },
    ({ scheduleId }) =>
      runTool(async () =>
        toolJson(await caller.recurring.generateNow({ scheduleId })),
      ),
  );

  server.registerTool(
    "delete_recurring_invoice",
    {
      title: "Delete recurring invoice",
      description:
        'Delete a recurring invoice and its template. Invoices it already generated are kept (they detach from the schedule). To stop billing but keep the record, set its status to "ended" instead.',
      inputSchema: { scheduleId: z.string().uuid() },
    },
    ({ scheduleId }) =>
      runTool(async () =>
        toolJson(await caller.recurring.delete({ scheduleId })),
      ),
  );

  // --- Expenses -----------------------------------------------------------
  // Tags travel as names (matched ignoring case); the tools turn them into ids.
  const tagNames = z
    .array(z.string().min(1).max(50))
    .max(20)
    .optional()
    .describe("Tag names, matched ignoring case. Unknown names are created.");

  server.registerTool(
    "list_expenses",
    {
      title: "List expenses",
      description:
        "List business expenses with their tags, optionally filtered to paid or unpaid and to expenses carrying any of the given tags. Receipt files are omitted from the list.",
      inputSchema: {
        status: z
          .enum(["unpaid", "paid"])
          .optional()
          .describe("Filter to expenses with this status."),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Only expenses carrying any of these tag names (ignoring case). Names that don't exist match nothing.",
          ),
      },
    },
    ({ status, tags }) =>
      runTool(async () => {
        if (!tags || tags.length === 0) {
          return toolJson(await caller.expenses.list({ status }));
        }
        const wanted = new Set(tags.map((name) => name.trim().toLowerCase()));
        const { tags: all } = await caller.expenses.tags.list();
        const tagIds = all
          .filter((tag) => wanted.has(tag.name.toLowerCase()))
          .map((tag) => tag.id);
        if (tagIds.length === 0) return toolJson([]);
        return toolJson(await caller.expenses.list({ status, tagIds }));
      }),
  );

  server.registerTool(
    "list_expense_tags",
    {
      title: "List expense tags",
      description:
        "List the business's expense tags (name, colour) with how many expenses carry each.",
      inputSchema: {},
    },
    () =>
      runTool(async () => toolJson((await caller.expenses.tags.list()).tags)),
  );

  server.registerTool(
    "get_expense",
    {
      title: "Get expense",
      description:
        "Fetch a single expense. The receipt file itself is not returned, only whether one is attached.",
      inputSchema: { expenseId: z.string().uuid() },
    },
    ({ expenseId }) =>
      runTool(async () => {
        const expense = await caller.expenses.get({ expenseId });
        // Never ship the (potentially multi-MB) receipt data URL to the model.
        const { receiptDataUrl, ...rest } = expense;
        return toolJson({ ...rest, hasReceipt: Boolean(receiptDataUrl) });
      }),
  );

  server.registerTool(
    "create_expense",
    {
      title: "Create expense",
      description:
        "Record a business expense. Upload a receipt file through the web app; this tool creates the expense without one.",
      inputSchema: {
        description: z.string().min(1).describe("What the expense was for."),
        amountMinor: z.number().int().positive().describe(MINOR),
        currency: currencyField,
        vendor: z.string().nullable().optional().describe("Who was paid."),
        category: z.string().nullable().optional(),
        incurredAt: z
          .string()
          .datetime()
          .describe(`Date the cost was incurred. ${ISO}`),
        notes: z.string().nullable().optional(),
        tags: tagNames,
      },
    },
    ({ incurredAt, tags, ...rest }) =>
      runTool(async () => {
        const tagIds =
          tags && tags.length > 0
            ? (await caller.expenses.tags.ensure({ names: tags })).map((t) => t.id)
            : undefined;
        return toolJson(
          await caller.expenses.create({
            ...rest,
            incurredAt: new Date(incurredAt),
            tagIds,
          }),
        );
      }),
  );

  server.registerTool(
    "set_expense_tags",
    {
      title: "Set expense tags",
      description:
        "Replace an expense's tags with exactly these names (an empty list removes them all). Unknown names are created. Nothing else on the expense changes.",
      inputSchema: {
        expenseId: z.string().uuid(),
        tags: z.array(z.string().min(1).max(50)).max(20).describe(
          "Tag names, matched ignoring case. Unknown names are created.",
        ),
      },
    },
    ({ expenseId, tags }) =>
      runTool(async () => {
        const expense = await caller.expenses.get({ expenseId });
        const tagIds =
          tags.length > 0
            ? (await caller.expenses.tags.ensure({ names: tags })).map((t) => t.id)
            : [];
        // update replaces every field, so send the stored ones back; leaving
        // receipt out keeps the receipt.
        await caller.expenses.update({
          expenseId,
          data: {
            description: expense.description,
            amountMinor: expense.amountMinor,
            currency: expense.currency,
            vendor: expense.vendor,
            category: expense.category,
            incurredAt: expense.incurredAt,
            notes: expense.notes,
            tagIds,
          },
        });
        const { receiptDataUrl, ...rest } = await caller.expenses.get({ expenseId });
        return toolJson({ ...rest, hasReceipt: Boolean(receiptDataUrl) });
      }),
  );

  server.registerTool(
    "mark_expense_paid",
    {
      title: "Mark expense paid",
      description: "Mark an expense as paid (records the time it was paid).",
      inputSchema: { expenseId: z.string().uuid() },
    },
    ({ expenseId }) =>
      runTool(async () =>
        toolJson(
          await caller.expenses.setStatus({ expenseId, status: "paid" }),
        ),
      ),
  );

  server.registerTool(
    "mark_expense_unpaid",
    {
      title: "Mark expense unpaid",
      description: "Return an expense to unpaid (clears its paid timestamp).",
      inputSchema: { expenseId: z.string().uuid() },
    },
    ({ expenseId }) =>
      runTool(async () =>
        toolJson(
          await caller.expenses.setStatus({ expenseId, status: "unpaid" }),
        ),
      ),
  );

  server.registerTool(
    "delete_expense",
    {
      title: "Delete expense",
      description: "Delete an expense permanently.",
      inputSchema: { expenseId: z.string().uuid() },
    },
    ({ expenseId }) =>
      runTool(async () => toolJson(await caller.expenses.delete({ expenseId }))),
  );

  server.registerTool(
    "get_invoice_pdf_link",
    {
      title: "Get invoice PDF download link",
      description:
        "Return a short-lived (15 minute) signed URL to download the invoice as a PDF. The link works without a browser login.",
      inputSchema: { invoiceId: z.string().uuid() },
    },
    ({ invoiceId }) =>
      runTool(async () => {
        // Confirm the invoice exists and belongs to this business (throws
        // NOT_FOUND otherwise) before minting a link for it.
        const invoice = await caller.invoices.get({ invoiceId });
        const token = signInvoicePdfToken({ invoiceId, businessId });
        const url = new URL(`/api/invoices/${invoiceId}/pdf`, baseUrl);
        url.searchParams.set("token", token);
        return toolJson({
          url: url.toString(),
          invoiceNumber: invoice.number,
          expiresInSeconds: 15 * 60,
        });
      }),
  );

  // --- Reports ------------------------------------------------------------
  server.registerTool(
    "get_profit_summary",
    {
      title: "Get profit summary",
      description:
        "Profit = income - expenses - internal labour cost, reported as per-currency buckets on two bases: 'cash' (paid invoices, paid expenses, cost of time billed on paid invoices) and 'accrual' (issued invoices, all expenses, cost of all billed time). Amounts are in minor units and never converted across currencies. Requires permission to view profit.",
      inputSchema: {
        from: z
          .string()
          .datetime()
          .optional()
          .describe(`Only count from this date (inclusive). ${ISO}`),
        to: z
          .string()
          .datetime()
          .optional()
          .describe(`Only count before this date (exclusive). ${ISO}`),
      },
    },
    ({ from, to }) =>
      runTool(async () =>
        toolJson(
          await caller.reports.profit({
            from: from ? new Date(from) : undefined,
            to: to ? new Date(to) : undefined,
          }),
        ),
      ),
  );

  // --- Team ---------------------------------------------------------------
  server.registerTool(
    "list_team_members",
    {
      title: "List team members",
      description:
        "List the people on the business and any pending invitations (invitations are visible to owners only).",
    },
    () => runTool(async () => toolJson(await caller.team.list())),
  );

  server.registerTool(
    "invite_team_member",
    {
      title: "Invite team member",
      description:
        "Invite someone to the business by email (owner only). Returns a shareable invite link to send them - there is no automatic email.",
      inputSchema: {
        email: z.string().email().describe("The invitee's email address."),
        role: z
          .enum(["owner", "member"])
          .optional()
          .describe("Defaults to member. Owners can manage settings and the team."),
      },
    },
    ({ email, role }) =>
      runTool(async () => {
        const invitation = await caller.team.invite({
          email,
          role: role ?? "member",
        });
        return toolJson({
          ...invitation,
          inviteUrl: `${baseUrl}/invite/${invitation.token}`,
        });
      }),
  );

  server.registerTool(
    "revoke_invitation",
    {
      title: "Revoke invitation",
      description: "Revoke a pending team invitation (owner only).",
      inputSchema: { invitationId: z.string().uuid() },
    },
    ({ invitationId }) =>
      runTool(async () => toolJson(await caller.team.revoke({ invitationId }))),
  );

  server.registerTool(
    "remove_team_member",
    {
      title: "Remove team member",
      description:
        "Remove a member from the business by their user id (owner only). The last owner cannot be removed.",
      inputSchema: { userId: z.string() },
    },
    ({ userId }) =>
      runTool(async () =>
        toolJson(await caller.team.removeMember({ userId })),
      ),
  );

  return server;
}
