import { asc, eq } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Db } from "@/db";
import { schema } from "@/db";

// The "export everything" capability: a single, business-scoped dump of every
// domain entity in one portable file - the anti-lock-in guarantee. A caller
// can take all of their business's data out of a Clerq instance and, because
// the format is documented and versioned (see docs/DATA-EXPORT.md), read it
// back in anywhere.
//
// Completeness is structural, not manual: EXPORT_ENTITIES below is checked in
// modules/export/service.test.ts against the schema itself, so any new
// business-scoped table that isn't added here fails the test. That mirrors the
// tenancy convention gate in db/schema.test.ts.

// Bump when the on-disk shape changes in a way an importer must branch on.
// Additive changes (a new entity, a new column on an existing entity) do not
// need a bump; a rename or a restructuring does.
export const EXPORT_FORMAT_VERSION = "1";

// A stable discriminator so a reader can recognise the file without guessing
// from its shape.
export const EXPORT_KIND = "clerq.business-export";

// Business-scoped tables (they carry business_id) that are deliberately NOT in
// the export, with the reason each is excluded. Mirrors the exemption list in
// db/schema.test.ts: the completeness test asserts every remaining
// business-scoped table is exported, so an omission here has to be a
// deliberate, documented decision.
export const EXPORT_EXEMPT_TABLES = [
  // A per-user UI pointer (which business a user is currently acting in). It
  // carries business_id only to satisfy the structural tenancy convention;
  // it is user session state, not the business's data.
  "user_active_business",
  // Platform moderation state imposed on the business by a platform admin.
  // Keyed by business_id but authored and owned by the platform, not the
  // business, and it references a platform admin's user id - not something a
  // tenant's own data export should carry.
  "business_suspension",
  // API keys are credentials (key hashes plus access scope), not business
  // data, and are useless outside this instance. An export file is meant to
  // be carried around; it should not carry anything that grants access.
  "api_key",
] as const;

// One exportable collection: the JSON key it lands under, the schema table it
// covers (the completeness gate maps entities to tables through this), and the
// business-scoped query that reads its rows.
type ExportEntity = {
  key: string;
  table: PgTable;
  select: (db: Db, businessId: string) => Promise<unknown[]>;
};

// The registry. Order is the order collections appear in the file (roughly:
// the business itself, then the client -> project -> task -> time -> invoice
// -> expense flow, then team and access). Every query is filtered by
// business_id so nothing but the caller's data can ever be read.
export const EXPORT_ENTITIES: ExportEntity[] = [
  {
    // The business row itself - name, address, currency, working hours, tax
    // config and branding. This is "settings" in the acceptance criteria. It
    // is the tenancy root (keyed by id, not business_id), so it is scoped by
    // id here rather than by a business_id column.
    key: "business",
    table: schema.business,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.business)
        .where(eq(schema.business.id, businessId)),
  },
  {
    key: "clients",
    table: schema.client,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.client)
        .where(eq(schema.client.businessId, businessId))
        .orderBy(asc(schema.client.createdAt)),
  },
  {
    // Per-client, per-member bill rates and internal costs.
    key: "clientMemberRates",
    table: schema.clientMemberRate,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.clientMemberRate)
        .where(eq(schema.clientMemberRate.businessId, businessId))
        .orderBy(asc(schema.clientMemberRate.createdAt)),
  },
  {
    key: "projects",
    table: schema.project,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.project)
        .where(eq(schema.project.businessId, businessId))
        .orderBy(asc(schema.project.createdAt)),
  },
  {
    key: "tasks",
    table: schema.task,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.task)
        .where(eq(schema.task.businessId, businessId))
        .orderBy(asc(schema.task.createdAt)),
  },
  {
    // Time entries, including any still-running timer (ended_at null). Receipts
    // aside, this is the raw record of every hour tracked.
    key: "timeEntries",
    table: schema.timeEntry,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.timeEntry)
        .where(eq(schema.timeEntry.businessId, businessId))
        .orderBy(asc(schema.timeEntry.createdAt)),
  },
  {
    key: "invoices",
    table: schema.invoice,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.businessId, businessId))
        .orderBy(asc(schema.invoice.createdAt)),
  },
  {
    // Ordered so a reader can reconstruct each invoice's lines in position
    // order without re-sorting.
    key: "invoiceLines",
    table: schema.invoiceLine,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.invoiceLine)
        .where(eq(schema.invoiceLine.businessId, businessId))
        .orderBy(
          asc(schema.invoiceLine.invoiceId),
          asc(schema.invoiceLine.position),
        ),
  },
  {
    // The gapless per-year numbering counters, so re-importing continues the
    // sequence rather than restarting it.
    key: "invoiceSequences",
    table: schema.invoiceSequence,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.invoiceSequence)
        .where(eq(schema.invoiceSequence.businessId, businessId))
        .orderBy(asc(schema.invoiceSequence.year)),
  },
  {
    // Recurring-invoice schedules (retainers). The invoices they produced are
    // already in `invoices` (with schedule_id); these are the templates.
    key: "invoiceSchedules",
    table: schema.invoiceSchedule,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.invoiceSchedule)
        .where(eq(schema.invoiceSchedule.businessId, businessId))
        .orderBy(asc(schema.invoiceSchedule.createdAt)),
  },
  {
    // Ordered so each schedule's template lines read back in position order.
    key: "invoiceScheduleLines",
    table: schema.invoiceScheduleLine,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.invoiceScheduleLine)
        .where(eq(schema.invoiceScheduleLine.businessId, businessId))
        .orderBy(
          asc(schema.invoiceScheduleLine.scheduleId),
          asc(schema.invoiceScheduleLine.position),
        ),
  },
  {
    // Expenses, including the inline receipt data URL - a full export means the
    // receipts come too, not just the metadata.
    key: "expenses",
    table: schema.expense,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.expense)
        .where(eq(schema.expense.businessId, businessId))
        .orderBy(asc(schema.expense.createdAt)),
  },
  {
    // The client activity thread (notes plus lifecycle events), in insertion
    // order (seq, not at: timestamps can collide within a microsecond).
    key: "activity",
    table: schema.activity,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.activity)
        .where(eq(schema.activity.businessId, businessId))
        .orderBy(asc(schema.activity.seq)),
  },
  {
    // Team memberships, enriched with each member's email and name so the
    // export identifies people, not just opaque user ids. The user's role and
    // any custom-role pointer travel with them.
    key: "members",
    table: schema.businessMember,
    select: (db, businessId) =>
      db
        .select({
          id: schema.businessMember.id,
          businessId: schema.businessMember.businessId,
          userId: schema.businessMember.userId,
          email: schema.user.email,
          name: schema.user.name,
          role: schema.businessMember.role,
          businessRoleId: schema.businessMember.businessRoleId,
          createdAt: schema.businessMember.createdAt,
          updatedAt: schema.businessMember.updatedAt,
        })
        .from(schema.businessMember)
        .innerJoin(
          schema.user,
          eq(schema.businessMember.userId, schema.user.id),
        )
        .where(eq(schema.businessMember.businessId, businessId))
        .orderBy(asc(schema.businessMember.createdAt)),
  },
  {
    // Custom, business-defined roles (a named bundle of permissions).
    key: "roles",
    table: schema.businessRole,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.businessRole)
        .where(eq(schema.businessRole.businessId, businessId))
        .orderBy(asc(schema.businessRole.createdAt)),
  },
  {
    // Per-member permission overrides (grant/deny) layered on top of a role.
    key: "memberPermissions",
    table: schema.businessMemberPermission,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.businessMemberPermission)
        .where(eq(schema.businessMemberPermission.businessId, businessId))
        .orderBy(asc(schema.businessMemberPermission.createdAt)),
  },
  {
    // Invitations to join the business, in every state (pending/accepted/
    // revoked) - the record of who was asked in.
    key: "invitations",
    table: schema.businessInvitation,
    select: (db, businessId) =>
      db
        .select()
        .from(schema.businessInvitation)
        .where(eq(schema.businessInvitation.businessId, businessId))
        .orderBy(asc(schema.businessInvitation.createdAt)),
  },
];

export type BusinessExport = {
  formatVersion: string;
  kind: string;
  // ISO 8601. When the snapshot was taken.
  exportedAt: string;
  businessId: string;
  // One key per EXPORT_ENTITIES entry; each value is that collection's rows,
  // scoped to the business. `business` holds exactly one row.
  data: Record<string, unknown[]>;
};

// Assemble the complete, business-scoped export. Every collection is read
// through EXPORT_ENTITIES, so this function needs no changes when a new domain
// entity is added - the entry (and the completeness test) is the only edit.
export async function exportBusinessData(
  db: Db,
  businessId: string,
  opts: { exportedAt?: Date } = {},
): Promise<BusinessExport> {
  const data: Record<string, unknown[]> = {};
  for (const entity of EXPORT_ENTITIES) {
    data[entity.key] = await entity.select(db, businessId);
  }
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    kind: EXPORT_KIND,
    exportedAt: (opts.exportedAt ?? new Date()).toISOString(),
    businessId,
    data,
  };
}

// The table names the export covers, for the completeness gate in the tests.
export function exportedTableNames(): Set<string> {
  return new Set(EXPORT_ENTITIES.map((entity) => getTableName(entity.table)));
}
