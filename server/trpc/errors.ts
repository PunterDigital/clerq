import { TRPCError } from "@trpc/server";

// What a caller may read of an error (#5584). Our own TRPCErrors carry
// messages written for people ("No such invoice"). An unexpected throw
// becomes INTERNAL_SERVER_ERROR with the original message, which for a
// database error is Drizzle's "Failed query: select ... params: ..." - the
// SQL, column names and bound values. Those never leave the server; the
// route handlers log the original.
export const GENERIC_ERROR_MESSAGE = "Something went wrong";

// A Drizzle query error, or a Postgres error (a five-character SQLSTATE
// code), anywhere along the cause chain.
export function isDatabaseError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 10; depth += 1) {
    if (typeof e !== "object") return false;
    const { name, message, code, cause } = e as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (name === "DrizzleQueryError") return true;
    if (typeof message === "string" && message.startsWith("Failed query")) return true;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !(e instanceof TRPCError)) {
      return true;
    }
    e = cause;
  }
  return false;
}

export function publicErrorMessage(err: unknown): string {
  if (isDatabaseError(err)) return GENERIC_ERROR_MESSAGE;
  if (err instanceof TRPCError) {
    if (err.code === "INTERNAL_SERVER_ERROR" && isDatabaseError(err.cause)) {
      return GENERIC_ERROR_MESSAGE;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return GENERIC_ERROR_MESSAGE;
}
