# Clerq REST API

Base URL: `https://app.useclerq.net/api/v1` (a self-hosted instance serves the
same paths on its own host). This page covers what every endpoint shares, then
lists the endpoints. An OpenAPI file comes in a later release.

## API keys

An owner or admin creates keys in **Settings -> API**. Each key:

- works only in the business it was made in, even if its creator switches to
  another business in the app;
- acts as the person who made it, with that person's permissions;
- is either **read only** (GET requests only) or **read and write**;
- is shown once. Clerq stores only a SHA-256 hash of it;
- stops working when it is revoked, or when its creator leaves the business.

Send it as a bearer token:

```bash
curl -H "Authorization: Bearer clq_..." https://app.useclerq.net/api/v1/health
```

The same key is also accepted by the MCP endpoint (`/api/mcp`), next to the
OAuth tokens that AI assistants use. Unlike those, a key does not expire.

## Health

`GET /api/v1/health` checks a key end to end and says which business and key
the request ran as:

```json
{
  "status": "ok",
  "version": "1.5.0",
  "business": { "id": "...", "name": "Acme Studio" },
  "key": { "id": "...", "name": "Panel sync", "scope": "write" }
}
```

## Errors

Errors are JSON with an HTTP status:

```json
{ "error": { "code": "not_found", "message": "Client not found" } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | The request body isn't JSON |
| 401 | `unauthorized` | No key, an unknown or revoked key, or its creator left the business |
| 403 | `forbidden` | The key is read only, or its creator lacks the permission |
| 404 | `not_found` | No such record, or no such endpoint |
| 409 | `conflict` | The record's state doesn't allow it (for example an issued invoice) |
| 422 | `validation_failed` | Invalid input, `limit` or `cursor` |
| 429 | `rate_limited` | Over the key's rate limit; see `Retry-After` |

## Rate limit

120 requests a minute per key. Every response carries `X-RateLimit-Limit` and
`X-RateLimit-Remaining`; a 429 carries `Retry-After` (seconds).

## Pagination

List endpoints return `{ "data": [...], "nextCursor": "..." }`. Pass
`?limit=` (1 to 200, default 50) and, for the next page, `?cursor=` with the
previous `nextCursor`. `nextCursor` is `null` on the last page.

## Requests

Send request bodies as JSON objects (`Content-Type: application/json`). A body
that isn't JSON is a 400; invalid fields are a 422 whose message starts with
the field, for example `name: Too small: expected string to have >=1 characters`.
Dates are ISO 8601 strings (`2026-12-01` or `2026-12-01T09:00:00Z`). Money is in
minor units (cents) with an ISO 4217 currency code.

`POST` that creates something answers 201. `PATCH` changes only the fields you
send; a field sent as `null` is cleared, and a list (such as a client's
`contacts`) is replaced as a whole. An id that doesn't exist, belongs to
another business or isn't a UUID is a 404.

## Clients

| Method and path | What it does |
| --- | --- |
| `GET /clients` | List clients, newest first. `?search=` (name contains), `?includeArchived=true` |
| `POST /clients` | Create a client: `name` (required), `contacts`, `notes`, `address`, `companyNumber`, `vatNumber`, `defaultRateMinor`, `defaultRateCurrency`, `defaultRateUnit` (`hour` or `day`), `budgetMinor`, `budgetCurrency` |
| `GET /clients/{id}` | One client |
| `PATCH /clients/{id}` | Change a client's fields |
| `POST /clients/{id}/archive` | Archive a client |
| `POST /clients/{id}/unarchive` | Bring an archived client back |
| `POST /clients/{id}/notes` | Add a note: `{ "text": "..." }` |
| `GET /clients/{id}/activity` | The client's activity thread (notes, changes, invoices), newest first |

`contacts` is a list of `{ "name", "email"?, "role"? }`.

## Projects

| Method and path | What it does |
| --- | --- |
| `GET /projects` | List projects with their client's name. `?clientId=`, `?search=` (project or client name contains) |
| `POST /projects` | Create a project: `name` and `clientId` (required), `status` (`active`, `on_hold`, `completed`), `dueDate`, `defaultRateMinor`, `defaultRateCurrency`, `defaultRateUnit`, `budgetMinor`, `budgetCurrency` |
| `GET /projects/{id}` | One project |
| `PATCH /projects/{id}` | Change a project's fields; `clientId` moves it to another client |

## Tasks

| Method and path | What it does |
| --- | --- |
| `GET /tasks?projectId=` | A project's tasks, oldest first, with `trackedSeconds` |
| `GET /tasks?search=` | Tasks whose title contains the term, across the business, newest first, with `projectName` and `clientName` |
| `POST /tasks` | Create a task: `projectId` and `title` (required), `status`, `estimateMinutes` |
| `GET /tasks/{id}` | One task |
| `PATCH /tasks/{id}` | Change a task's `title`, `status` or `estimateMinutes` |
| `POST /tasks/{id}/status` | Set only the status: `{ "status": "done" }` |
| `DELETE /tasks/{id}` | Delete a task and its time entries. 409 while any of its time is on an invoice |

Both task lists take `?status=` (`todo`, `in_progress`, `in_review`, `done`).
`GET /tasks` needs `projectId` or `search`.

```bash
curl -X POST https://app.useclerq.net/api/v1/tasks \
  -H "Authorization: Bearer clq_..." -H "Content-Type: application/json" \
  -d '{"projectId": "...", "title": "Write the brief", "estimateMinutes": 90}'
```

## Time entries and timers

A key acts as the person who made it, so "my" time and the timer are always
that person's: a key can't start or stop someone else's timer.

| Method and path | What it does |
| --- | --- |
| `GET /time-entries?taskId=` | Everyone's entries on a task, newest first (needs permission to view all time). Add `from` and `to` to limit it to a date range |
| `GET /time-entries?from=&to=` | The key creator's own finished entries with `startedAt` in `[from, to)`, oldest first, with task, project and client names |
| `POST /time-entries` | Log a manual entry: `taskId`, `startedAt` and `durationSeconds` (required), `billable` (default `true`), `note`, `rateMinor`, `rateCurrency` |
| `PATCH /time-entries/{id}` | Change the note: `{ "note": "..." }`, or `null` to clear it |
| `DELETE /time-entries/{id}` | Delete an entry |
| `GET /timer` | The running timer: `{ "timer": {...} }`, or `{ "timer": null }` |
| `POST /timer/start` | Start a timer on a task: `{ "taskId": "..." }`. A running timer is stopped and saved first |
| `POST /timer/stop` | Stop the running timer: `{ "entry": {...} }`, or `{ "entry": null }` if none was running |

`from` and `to` are ISO 8601 dates or date-times. The entry's frozen internal
cost (`internalCostMinor`, `internalCostCurrency`) is only included when the
key's creator may view profit.

## Invoices

Statuses are `draft`, `sent`, `overdue`, `paid` and `void`. Only a draft can be
changed or deleted; once issued, an invoice can only be marked paid or voided.
A change the status doesn't allow is a 409.

| Method and path | What it does |
| --- | --- |
| `GET /invoices` | List invoices, newest first, with `clientName`. `?status=`, `?clientId=`, `?search=` (number or client name contains) |
| `POST /invoices` | Create a draft: `clientId`, `currency` and `taxTreatment` (`standard`, `zero_rated`, `reverse_charge`) required; `projectId`, `issueDate`, `dueDate`, `periodStart`, `periodEnd` |
| `GET /invoices/{id}` | One invoice with its `lines` |
| `PATCH /invoices/{id}` | Change a draft's `issueDate`, `dueDate`, `periodStart`, `periodEnd` or `notes` |
| `DELETE /invoices/{id}` | Delete a draft; its time goes back to unbilled. 409 for an issued invoice: void it instead |
| `POST /invoices/{id}/lines` | Add a fixed-amount line to a draft: `{ "description", "amountMajor": "1500.00" }` |
| `PATCH /invoices/{id}/lines/{lineId}` | Change a draft line's `description` or `amountMajor`. A new amount replaces its hours x rate breakdown |
| `DELETE /invoices/{id}/lines/{lineId}` | Remove a draft line; its time goes back to unbilled |
| `POST /invoices/{id}/generate-from-time` | Fill a draft from the client's unbilled billable time: `grouping` (`person_rate`, `task`, `single`) required; `projectId`, `includeTaskList`, `replace` (regenerate the time lines), `fxRates` |
| `POST /invoices/{id}/issue` | Number the draft and mark it sent |
| `POST /invoices/{id}/mark-paid` | Mark a sent or overdue invoice paid |
| `POST /invoices/{id}/void` | Void a sent or overdue invoice, optionally `{ "reason": "..." }`. It keeps its number; its time goes back to unbilled |
| `POST /invoices/{id}/duplicate` | Copy any invoice into a new draft |
| `GET /invoices/{id}/pdf-link` | `{ "url", "invoiceNumber", "expiresInSeconds" }`: a link that downloads the PDF without a key or login, for 15 minutes |

Line amounts are sent as `amountMajor`, a plain decimal string in the
invoice's currency (`"1500"` or `"1500.00"`), and come back in minor units
(`totalMinor`). An amount with more decimals than the currency allows is a 422.
A `standard` invoice needs a standard VAT rate in settings, and a
`reverse_charge` invoice needs both VAT numbers before it can be issued (409).

`generate-from-time` answers with what it added, or with why nothing was
added: `nothing_to_bill` (with where the client's time is) or
`missing_fx_rates` (time priced in other currencies; send `fxRates`, keyed by
currency, as `{ "rate": "1.17", "source": "manual" }`).

```bash
curl -X POST https://app.useclerq.net/api/v1/invoices/.../lines \
  -H "Authorization: Bearer clq_..." -H "Content-Type: application/json" \
  -d '{"description": "Design work, October", "amountMajor": "1500.00"}'
```

## Recurring invoices

A recurring invoice (retainer) generates an invoice on a schedule, as a draft
or issued (`autoIssue`).

| Method and path | What it does |
| --- | --- |
| `GET /recurring-invoices` | List schedules with `clientName` and `nextRunAt`. `?status=` (`active`, `paused`, `ended`) |
| `POST /recurring-invoices` | Create a schedule (fields below) |
| `GET /recurring-invoices/{id}` | One schedule with its `lines` |
| `PATCH /recurring-invoices/{id}` | Change the fields sent; `lines` is replaced as a whole list. Invoices already generated don't change |
| `DELETE /recurring-invoices/{id}` | Delete the schedule. The invoices it generated stay |
| `GET /recurring-invoices/{id}/invoices` | The invoices it has generated |
| `POST /recurring-invoices/{id}/status` | `{ "status": "active" \| "paused" \| "ended" }` |
| `POST /recurring-invoices/{id}/generate` | Generate the next invoice now: `{ "generated", "issued", "error" }`. 409 unless active |

Fields: `clientId`, `name`, `currency`, `taxTreatment`, `frequency` (`weekly`,
`monthly`, `quarterly`, `yearly`), `interval` (1 to 52), `startDate`,
`netTermsDays` (0 to 365), `autoIssue` and `lines` (1 to 50 of
`{ "description", "amountMajor" }`) are required; `projectId`, `endDate`,
`occurrenceLimit` and `notes` are optional.
