import { eq } from "drizzle-orm";

import { getDb, schema, type Db } from "@/db";
import {
  getActiveImpersonation,
  type ActiveImpersonation,
} from "@/modules/platform/impersonation";
import { getAuth, type Session } from "@/server/auth";

// The session the app acts on. Normally the Better Auth session as-is; while
// a platform admin is impersonating (modules/platform/impersonation.ts) the
// user is swapped for the target and `impersonation` says so. `session` (the
// Better Auth session row) always stays the admin's own.
export type AppSession = Session & { impersonation?: ActiveImpersonation };

// Every server-side read of "who is signed in" goes through here, never
// getAuth().api.getSession directly, so impersonation applies everywhere:
// pages, the tRPC context, and the download routes.
export async function getEffectiveSession(headers: Headers): Promise<AppSession | null> {
  const session = (await getAuth().api.getSession({ headers })) as Session | null;
  if (!session) return null;
  return applyImpersonation(getDb(), session);
}

// Split from getEffectiveSession so it can be tested without Better Auth.
export async function applyImpersonation(
  db: Db,
  session: Session,
  now: Date = new Date(),
): Promise<AppSession> {
  const impersonation = await getActiveImpersonation(db, session.session.id, now);
  if (!impersonation || impersonation.adminUserId !== session.user.id) {
    return session;
  }
  const [target] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, impersonation.targetUserId));
  if (!target) return session;
  return { ...session, user: { ...session.user, ...target }, impersonation };
}
