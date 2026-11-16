import type { Metadata } from "next";
import { headers } from "next/headers";

import { getEffectiveSession } from "@/server/session";
import { caller } from "@/server/trpc/server";

import { TeamManager } from "./team-manager";

export const metadata: Metadata = {
  title: "Team - Clerq",
};

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await getEffectiveSession(await headers());
  const {
    members,
    invitations,
    overrides,
    customRoles,
    canInvite,
    canRemove,
    canManageRoles,
    assignableRoles,
  } = await caller.team.list();

  return (
    <TeamManager
        members={members}
        invitations={invitations}
        overrides={overrides}
        customRoles={customRoles}
        currentUserId={session?.user.id ?? ""}
        canInvite={canInvite}
        canRemove={canRemove}
        canManageRoles={canManageRoles}
        assignableRoles={assignableRoles}
    />
  );
}
