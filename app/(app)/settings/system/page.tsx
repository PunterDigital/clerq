import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getRequestMembership, getRequestSession } from "@/server/request-scope";
import { caller } from "@/server/trpc/server";

import { SystemAdminForm } from "../system-admin-form";

export const metadata: Metadata = {
  title: "System - Clerq",
};

export const dynamic = "force-dynamic";

export default async function SystemSettingsPage() {
  const session = await getRequestSession();
  const membership = session
    ? await getRequestMembership(session.user.id)
    : null;
  const canManageUpdates =
    membership?.permissions.has("settings.manageUpdates") ?? false;
  const systemSettings = canManageUpdates
    ? await caller.system.settings()
    : null;

  // System Administration is owner/admin only and has nothing to show on the
  // cloud instance - anyone else who reaches this route is sent back to General.
  if (!systemSettings || systemSettings.isCloudInstance) {
    redirect("/settings");
  }

  return (
    <SystemAdminForm
      initial={{
        currentVersion: systemSettings.currentVersion,
        updateChecksEnabled: systemSettings.updateChecksEnabled,
      }}
    />
  );
}
