# Clerq REST API

Base URL: `https://app.useclerq.net/api/v1` (a self-hosted instance serves the
same paths on its own host). The full endpoint reference and an OpenAPI file
come with the endpoint releases; this page covers what every endpoint shares.

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
