import { headers } from "next/headers";

import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { caller } from "@/server/trpc/server";

import { SettingsTabs, type SettingsTab } from "./settings-tabs";

// Wraps every /settings route with a shared header and tabbed navigation so the
// settings area reads as one place with clear categories, rather than a single
// long stack of cards. Each tab is its own route (deep-linkable, server-gated).
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const membership = session
    ? await getActiveMembership(session.user.id)
    : null;

  // The System tab only exists on self-hosted deployments for callers who can
  // manage instance updates - same gate the old single page used.
  const canManageUpdates =
    membership?.permissions.has("settings.manageUpdates") ?? false;
  const systemSettings = canManageUpdates
    ? await caller.system.settings()
    : null;
  const showSystemTab = Boolean(systemSettings && !systemSettings.isCloudInstance);

  const tabs: SettingsTab[] = [
    { href: "/settings", label: "General" },
    { href: "/settings/branding", label: "Branding" },
    { href: "/settings/ai", label: "AI" },
    { href: "/settings/team", label: "Team" },
    // The CSV import wizard lives at /settings/import but belongs to Data.
    { href: "/settings/data", label: "Data", match: ["/settings/import"] },
    ...(membership?.permissions.has("apiKeys.manage")
      ? [{ href: "/settings/api", label: "API" } as SettingsTab]
      : []),
    ...(showSystemTab
      ? [{ href: "/settings/system", label: "System" } as SettingsTab]
      : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="text-2xl">Settings</h1>
      <SettingsTabs tabs={tabs} />
      {children}
    </div>
  );
}
