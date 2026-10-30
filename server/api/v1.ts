import { TRPCError } from "@trpc/server";
import { ZodError } from "zod";

import { getDb } from "@/db";
import {
  getBusinessSuspension,
  getUserSuspension,
} from "@/modules/platform/service";
import { bearerToken, verifyApiKey, type VerifiedApiKey } from "@/server/api-keys";
import {
  createClerqCaller,
  mcpContextForUser,
  type ClerqCaller,
} from "@/server/mcp/caller";
import { getMembershipIn, type ActiveMembership } from "@/server/membership";

// The REST API base (/api/v1). Every endpoint is a thin adapter over the same
// tRPC procedures the web app and MCP use, called as the key's creator and
// pinned to the key's business, so the business rules, Zod validation and the
// business_id boundary are shared rather than reimplemented.
//
// Errors are always JSON: { "error": { "code": "not_found", "message": "..." } }.

export type ApiContext = {
  caller: ClerqCaller;
  key: VerifiedApiKey;
  membership: ActiveMembership;
  url: URL;
};

type Handler = (req: Request, ctx: ApiContext) => Promise<unknown>;

const STATUS_BY_CODE: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_failed",
  429: "rate_limited",
  500: "internal_error",
};

export function apiError(
  status: number,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { code: STATUS_BY_CODE[status] ?? "error", message } },
    { status, headers },
  );
}

// Thrown by endpoint code for a clean JSON error.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_TRPC_CODE: Partial<Record<TRPCError["code"], number>> = {
  BAD_REQUEST: 422,
  PARSE_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 409,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
};

// Maps whatever an endpoint threw to a JSON error. Unknown errors become a
// bare 500 so internals never leak.
export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return apiError(err.status, err.message);
  if (err instanceof ZodError) {
    return apiError(422, err.issues[0]?.message ?? "Invalid input");
  }
  if (err instanceof TRPCError) {
    const status = STATUS_BY_TRPC_CODE[err.code] ?? 500;
    if (status === 500) {
      console.error(err);
      return apiError(500, "Something went wrong");
    }
    // Input validation arrives as a ZodError in the cause; show its first
    // issue rather than tRPC's stringified issue list.
    if (err.cause instanceof ZodError) {
      return apiError(status, err.cause.issues[0]?.message ?? err.message);
    }
    return apiError(status, err.message);
  }
  console.error(err);
  return apiError(500, "Something went wrong");
}

// -- Rate limit ----------------------------------------------------------------

// Requests per key per minute. In-memory, fixed window: Clerq runs as one
// process per deployment, so a shared store would add a dependency for nothing.
export const RATE_LIMIT_PER_MINUTE = 120;
const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

export function takeRateLimit(
  keyId: string,
  now = Date.now(),
): { ok: boolean; remaining: number; retryAfterSeconds: number } {
  let window = windows.get(keyId);
  if (!window || now - window.start >= WINDOW_MS) {
    window = { start: now, count: 0 };
    windows.set(keyId, window);
    // Drop windows that ended long ago so the map can't grow without bound.
    if (windows.size > 10_000) {
      for (const [id, w] of windows) {
        if (now - w.start >= WINDOW_MS) windows.delete(id);
      }
    }
  }
  window.count += 1;
  const retryAfterSeconds = Math.ceil((window.start + WINDOW_MS - now) / 1000);
  return {
    ok: window.count <= RATE_LIMIT_PER_MINUTE,
    remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - window.count),
    retryAfterSeconds,
  };
}

export function resetRateLimits(): void {
  windows.clear();
}

// -- Pagination ----------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type Page<T> = { data: T[]; nextCursor: string | null };

// Cursor pagination over an ordered list: ?limit=1..200 (default 50) and
// ?cursor= from the previous page's nextCursor. The cursor is opaque to
// callers; a malformed one is a 422, not a silent first page.
export function paginate<T>(items: readonly T[], url: URL): Page<T> {
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam === null ? DEFAULT_PAGE_SIZE : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ApiError(422, `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  }
  const cursor = url.searchParams.get("cursor");
  const offset = cursor === null ? 0 : decodeCursor(cursor);
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return { data, nextCursor: next < items.length ? encodeCursor(next) : null };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    const offset = (parsed as { o?: unknown }).o;
    if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) {
      return offset;
    }
  } catch {
    // fall through
  }
  throw new ApiError(422, "cursor is not valid");
}

// -- Route wrapper -------------------------------------------------------------

// Wraps an endpoint: authenticates the bearer key, applies the rate limit,
// resolves the key's business membership, and turns the handler's return value
// into a JSON 200 (or passes a Response through).
export function apiRoute(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const token = bearerToken(req.headers);
    if (!token) {
      return apiError(401, "Send an API key as: Authorization: Bearer <key>", {
        "WWW-Authenticate": "Bearer",
      });
    }
    const db = getDb();
    const key = await verifyApiKey(db, token);
    if (!key) {
      return apiError(401, "This API key is not valid or has been revoked", {
        "WWW-Authenticate": "Bearer",
      });
    }

    const limit = takeRateLimit(key.id);
    const limitHeaders = {
      "X-RateLimit-Limit": String(RATE_LIMIT_PER_MINUTE),
      "X-RateLimit-Remaining": String(limit.remaining),
    };
    if (!limit.ok) {
      return apiError(429, "Too many requests for this API key, slow down", {
        ...limitHeaders,
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }

    const membership = await getMembershipIn(key.userId, key.businessId);
    if (!membership) {
      return apiError(
        401,
        "The person who created this API key is no longer in the business",
      );
    }
    const suspended =
      (await getUserSuspension(db, key.userId)) ??
      (await getBusinessSuspension(db, key.businessId));
    if (suspended) {
      return apiError(403, "This account or business has been suspended");
    }

    const caller = createClerqCaller(
      mcpContextForUser(key.userId, req.headers, {
        id: key.id,
        businessId: key.businessId,
        scope: key.scope,
      }),
    );
    try {
      const result = await handler(req, {
        caller,
        key,
        membership,
        url: new URL(req.url),
      });
      if (result instanceof Response) {
        for (const [name, value] of Object.entries(limitHeaders)) {
          result.headers.set(name, value);
        }
        return result;
      }
      return Response.json(result, {
        headers: { ...limitHeaders, "Cache-Control": "no-store" },
      });
    } catch (err) {
      const res = errorResponse(err);
      for (const [name, value] of Object.entries(limitHeaders)) {
        res.headers.set(name, value);
      }
      return res;
    }
  };
}
