import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@/db";
import { isPlatformAdmin } from "@/modules/platform/service";
import { getEffectiveSession } from "@/server/session";

import { SystemAdminNav } from "./nav";

// Deliberately its own top-level route, outside the (app) group: a platform
// admin need not belong to any business, so this can't sit inside (app)'s
// layout, which redirects anyone without a membership to /onboarding. Every
// page here is per-request - the gate itself reads the session and the DB.
export const dynamic = "force-dynamic";

export default async function SystemAdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getEffectiveSession(await headers());
  if (!session) {
    redirect("/sign-in");
  }
  const admin = await isPlatformAdmin(getDb(), session.user.id);
  if (!admin) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex h-[var(--topbar-height)] shrink-0 items-center gap-4 border-b bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-6 backdrop-blur-[10px] backdrop-saturate-[140%]">
        <span className="text-sm font-semibold">System Administration</span>
        <SystemAdminNav />
        <div className="flex-1" />
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Clerq
        </Link>
      </header>
      <main className="mx-auto w-full max-w-[var(--content-max)] flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
