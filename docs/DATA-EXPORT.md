# Data export

Clerq's anti-lock-in guarantee: a single action exports **all** of a business's
data into one portable, documented file. Your data is yours - you can take it
out of any Clerq instance whenever you like, and read it back in anywhere.

## Exporting

Three equivalent entry points, all scoped to your **active business** and all
gated on the `data.export` permission (held by owners and admins by default):

- **Settings page** - _Settings → Export your data → "Export all data"_.
  Downloads the file in your browser.
- **HTTP** - `GET /api/export` with your session cookie. Responds with
  `Content-Type: application/json` and a
  `Content-Disposition: attachment; filename="clerq-export-<business>-<date>.json"`.
- **tRPC** - `dataExport.everything` returns the same object programmatically.

The export always reflects the caller's active business only; a business you
are not a member of can never appear in the file. A suspended business cannot
be exported (its data is preserved but inaccessible, like every other action).

## File format

A single JSON object. The current `formatVersion` is `1`.

```jsonc
{
  "kind": "clerq.business-export",
  "formatVersion": "1",
  "exportedAt": "2026-07-04T12:00:00.000Z", // ISO 8601, when the snapshot was taken
  "businessId": "…uuid…",
  "data": {
    "business":          [ /* exactly one row: the settings */ ],
    "clients":           [ … ],
    "clientMemberRates": [ … ],
    "projects":          [ … ],
    "tasks":             [ … ],
    "timeEntries":       [ … ],
    "invoices":          [ … ],
    "invoiceLines":      [ … ],
    "invoiceSequences":  [ … ],
    "invoiceSchedules":     [ … ],
    "invoiceScheduleLines": [ … ],
    "expenses":          [ … ],
    "activity":          [ … ],
    "members":           [ … ],
    "roles":             [ … ],
    "memberPermissions": [ … ],
    "invitations":       [ … ]
  }
}
```

Each key under `data` is a collection of rows drawn straight from the
corresponding database table (see `db/schema.ts`), so column names and value
encodings match the schema:

| Collection          | Source table                  | Notes                                                                 |
| ------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `business`          | `business`                    | The settings row: name, address, currency, `hoursPerDay`, `taxConfig`, `branding`. Exactly one. |
| `clients`           | `client`                      | Includes embedded `contacts`, rates, budgets, archive state.          |
| `clientMemberRates` | `client_member_rate`          | Per-client, per-member bill rates and internal costs.                 |
| `projects`          | `project`                     |                                                                       |
| `tasks`             | `task`                        |                                                                       |
| `timeEntries`       | `time_entry`                  | Includes a running timer (null `endedAt`) if one is active.           |
| `invoices`          | `invoice`                     |                                                                       |
| `invoiceLines`      | `invoice_line`                | Ordered by invoice, then `position`.                                  |
| `invoiceSequences`  | `invoice_sequence`            | The gapless per-year numbering counters.                              |
| `invoiceSchedules`     | `invoice_schedule`         | Recurring-invoice (retainer) templates and cadence.                   |
| `invoiceScheduleLines` | `invoice_schedule_line`    | Ordered by schedule, then `position`.                                 |
| `expenses`          | `expense`                     | Includes the inline receipt (`receiptDataUrl`) when present.          |
| `activity`          | `activity`                    | The client activity thread, in insertion order.                       |
| `members`           | `business_member` + `user`    | Enriched with each member's `email` and `name`.                       |
| `roles`             | `business_role`               | Custom, business-defined roles.                                       |
| `memberPermissions` | `business_member_permission`  | Per-member grant/deny overrides.                                      |
| `invitations`       | `business_invitation`         | Every invitation in any state.                                        |

### Value encodings

- **Money** is an integer in the currency's minor unit (e.g. `1050` = £10.50),
  as everywhere else in Clerq - floats never touch money.
- **Timestamps** are ISO 8601 strings.
- **Receipts / logos** are inline `data:` URLs (base64), so a full export is
  self-contained - there is no separate blob store to carry alongside it.

### Foreign keys

Rows reference each other by the ids present in the file - a `project` names
its `clientId`, a `timeEntry` its `taskId` and `userId`, and so on. User ids in
`timeEntries`, `clientMemberRates`, `activity` and `invitations` correspond to
the `userId` of a row in `members`, where the human-readable email and name
live.

## What is deliberately excluded

Three business-scoped tables are intentionally left out, because they are not
the business's own data:

- `user_active_business` - a per-user UI pointer (which business a user is
  currently viewing), not business data.
- `business_suspension` - platform moderation state imposed on the business by
  a platform administrator.
- `api_key` - API key hashes and their access scope. They are credentials for
  this instance, not data, and an export file should never grant access.

Instance-level infrastructure (auth users/sessions, OAuth tokens, instance
settings, platform-admin records) is likewise not part of a business export.

## Compatibility

`formatVersion` is bumped only for a breaking change (a rename or a
restructuring). Adding a new collection, or a new field to an existing one, is
additive and does not bump the version - an importer should ignore keys and
fields it does not recognise. Completeness is enforced by a test
(`modules/export/service.test.ts`): every business-scoped domain table must
appear in the export, so a newly added entity cannot silently be left out.
