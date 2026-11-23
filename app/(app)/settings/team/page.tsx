import type { Metadata } from "next";

import { getRequestSession } from "@/server/request-scope";
import { caller } from "@/server/trpc/server";

import { TeamManager } from "./team-manager";

export const metadata: Metadata = {
  title: "Team - Clerq",
};

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await getRequestSession();
  const {
    members,
    invitations,
    overrides,
    customRoles,
    canInvite,
    canRemove,
    canManageRoles,
    assignableRoles,
    assignableCustomRoleIds,
    roleEditableUserIds,
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
        assignableCustomRoleIds={assignableCustomRoleIds}
        roleEditableUserIds={roleEditableUserIds}
    />
  );
}
