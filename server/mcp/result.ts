import { TRPCError } from "@trpc/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { publicErrorMessage } from "@/server/trpc/errors";

// How the tool layer speaks back to the model. Successful tool calls return
// the procedure's data as pretty JSON; failures come back as a readable
// `isError` result rather than throwing, so the model sees the reason and can
// correct itself instead of the whole MCP request blowing up.

// Drizzle returns bigserial columns (e.g. activity.seq) as strings, but guard
// against any stray bigint so JSON.stringify never throws mid-tool.
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toolJson(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, jsonReplacer, 2) }],
  };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// tRPC error codes carry intent; surface them as something the model can act
// on. NOT_FOUND on a business-scoped id also means "belongs to another
// business" - the procedures deliberately make those indistinguishable.
const CODE_PREFIX: Record<string, string> = {
  UNAUTHORIZED: "Not authenticated",
  FORBIDDEN: "Not allowed",
  NOT_FOUND: "Not found",
  BAD_REQUEST: "Invalid request",
  PRECONDITION_FAILED: "Precondition failed",
  CONFLICT: "Conflict",
};

// A database error's text (SQL, params) is never handed to the model (#5584).
export function describeError(error: unknown): string {
  const message = publicErrorMessage(error);
  if (message !== (error as { message?: unknown } | null)?.message) {
    console.error(error);
  }
  if (error instanceof TRPCError) {
    const label = CODE_PREFIX[error.code] ?? error.code;
    return `${label}: ${message}`;
  }
  if (error instanceof Error) return message;
  return "Unexpected error";
}

// Wraps a tool body so any thrown error (tRPC or otherwise) becomes an
// `isError` result instead of rejecting the JSON-RPC request.
export async function runTool(
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return toolError(describeError(error));
  }
}
