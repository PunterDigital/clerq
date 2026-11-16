import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getEffectiveSession } from "@/server/session";
import { getActiveMembership } from "@/server/membership";
import { caller } from "@/server/trpc/server";

import { SystemAdminForm } from "../system-admin-form";

export const metadata: Metadata = {
  title: "System - Clerq",
};

export const dynamic = "force-dynamic";

export default async function SystemSettingsPage() {
  const session = await getEffectiveSession(await headers());
  const membership = session
    ? await getActiveMembership(session.user.id)
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
