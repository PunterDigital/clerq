import { redirect } from "next/navigation";

import { ImpersonationBanner } from "@/components/app-shell/impersonation-banner";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { UpdateBanner } from "@/components/app-shell/update-banner";
import { getDb } from "@/db";
import { isPlatformAdmin } from "@/modules/platform/service";
import {
  getRequestBusinessSuspension,
  getRequestMembership,
  getRequestSession,
  getRequestUserSuspension,
} from "@/server/request-scope";
import { caller } from "@/server/trpc/server";

import { SuspendedNotice } from "./suspended-notice";

// Every page in this group is per-request: the layout itself checks the
// session and reads the DB, so nothing here can be prerendered.
export const dynamic = "force-dynamic";

// The signed-in app shell: sidebar + topbar are the only fixed chrome
// (design system layout rule). Auth and membership are enforced here for
// every page in the group.
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getRequestSession();
  if (!session) {
    redirect("/sign-in");
  }

  // A suspended account never sees the app shell - mirrors the FORBIDDEN
  // server/trpc/init.ts throws on every request, but as a friendly page
  // instead of an error bubbling up from the first tRPC call.
  // While a platform admin views as this user, the banner (with the way
  // out) tops every page, the suspension notices included.
  const banner = session.impersonation ? (
    <ImpersonationBanner
      userName={session.user.name}
      userEmail={session.user.email}
      expiresAt={session.impersonation.expiresAt}
    />
  ) : null;

  const userSuspension = await getRequestUserSuspension(session.user.id);
  if (userSuspension) {
    return (
      <>
        {banner}
        <SuspendedNotice scope="account" reason={userSuspension.reason} />
      </>
    );
  }

  const membership = await getRequestMembership(session.user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const businessSuspension = await getRequestBusinessSuspension(membership.businessId);
  if (businessSuspension) {
    return (
      <>
        {banner}
        <SuspendedNotice scope="business" reason={businessSuspension.reason} />
      </>
    );
  }

  const [businesses, admin] = await Promise.all([
    caller.business.list(),
    isPlatformAdmin(getDb(), session.user.id),
  ]);

  // Update checking is owner/admin only (and skipped for the cloud instance,
  // and for anyone who has turned it off) - fetched conditionally so the rest
  // of the team never hits the permission gate.
  const updateStatus = membership.permissions.has("settings.manageUpdates")
    ? await caller.system.updateStatus()
    : null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isPlatformAdmin={admin} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {banner}
        <Topbar businesses={businesses} userName={session.user.name} isPlatformAdmin={admin} />
        {updateStatus?.checked && updateStatus.updateAvailable ? (
          <UpdateBanner
            currentVersion={updateStatus.currentVersion}
            latestVersion={updateStatus.latestVersion}
          />
        ) : null}
        <main className="mx-auto w-full max-w-[var(--content-max)] flex-1 px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
