import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getDb } from "@/db";
import {
  assignableRoles,
  holdsAll,
  isPermission,
  isRole,
  PERMISSION_SET,
  type Permission,
  type StoredRole,
} from "@/modules/authz";
import {
  acceptInvitation,
  createCustomRole,
  deleteCustomRole,
  getCustomRole,
  getInvitationPreview,
  inviteInputSchema,
  inviteMember,
  listCustomRoles,
  listMemberOverrides,
  listMembers,
  listPendingInvitations,
  removeMember,
  setMemberCustomRole,
  setMemberPermission,
  setMemberRole,
  revokeInvitation,
  updateCustomRole,
} from "@/modules/team/service";
import { getMembershipIn } from "@/server/membership";

import {
  authedProcedure,
  createTRPCRouter,
  permissionProcedure,
  publicProcedure,
} from "../init";

type ResolvedRole = { role: StoredRole; businessRoleId: string | null };

// Who is handing out a role: their role in the business and their resolved
// permissions (role + overrides).
type Actor = {
  businessId: string;
  businessRole: StoredRole;
  permissions: ReadonlySet<Permission>;
};

// Resolve a wire role value (a predefined role key or a custom role id) into a
// stored role the actor may hand out. Used by both `invite` and `setRole` (and
// so by MCP's invite_team_member, which calls `invite`). Only an owner may
// assign the owner role, and a non-owner may only assign a role whose
// permissions they all hold themselves (`holdsAll`, the rule createRole and
// setPermission already use): otherwise a manager could invite a second
// account as admin (#5582). Throws FORBIDDEN/NOT_FOUND on failure.
async function resolveAssignableRole(
  actor: Actor,
  value: string,
): Promise<ResolvedRole> {
  if (isRole(value)) {
    if (!assignableRoles(actor.businessRole, actor.permissions).includes(value)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          value === "owner"
            ? "Only an owner can assign the owner role"
            : `You can't assign the ${value} role - it has permissions you don't have yourself`,
      });
    }
    return { role: value, businessRoleId: null };
  }
  // Otherwise it must be one of the business's own custom roles.
  const custom = await getCustomRole(getDb(), actor.businessId, value);
  if (!custom) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such role" });
  }
  if (actor.businessRole !== "owner" && !holdsAll(actor.permissions, custom.permissions)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can't assign that role - it has permissions you don't have yourself",
    });
  }
  return { role: "custom", businessRoleId: custom.id };
}

// Whether the actor may change this member's role at all. Only an owner may
// change an owner's role, and a non-owner may only change the role of someone
// whose current permissions they all hold: a custom role with
// team.manageRoles can't demote an admin, for example (#5582).
async function canChangeRoleOf(actor: Actor, userId: string): Promise<boolean> {
  if (actor.businessRole === "owner") return true;
  const target = await getMembershipIn(userId, actor.businessId);
  if (!target) return true; // Not on the team: the caller answers NOT_FOUND.
  if (target.role === "owner") return false;
  return holdsAll(actor.permissions, target.permissions);
}

// Validate a custom role's permission list: every entry must be a real
// permission, and the actor can't include a permission they don't hold
// themselves (same anti-escalation rule as granting an override).
function sanitizeRolePermissions(
  actorPermissions: ReadonlySet<Permission>,
  values: string[],
): Permission[] {
  const permissions: Permission[] = [];
  for (const value of values) {
    if (!isPermission(value)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown permission: ${value}` });
    }
    if (!actorPermissions.has(value)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can't grant a permission you don't have yourself",
      });
    }
    permissions.push(value);
  }
  return permissions;
}

const roleNameSchema = z.string().trim().min(1).max(60);

async function getMemberOrThrow(businessId: string, userId: string) {
  const members = await listMembers(getDb(), businessId);
  const member = members.find((m) => m.userId === userId);
  if (!member) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That person isn't on your team",
    });
  }
  return member;
}

export const teamRouter = createTRPCRouter({
  list: permissionProcedure("team.view").query(async ({ ctx }) => {
    const canInvite = ctx.permissions.has("team.invite");
    const canManageRoles = ctx.permissions.has("team.manageRoles");

    const members = await listMembers(getDb(), ctx.businessId);
    const customRoles = await listCustomRoles(getDb(), ctx.businessId);
    const invitations = canInvite
      ? await listPendingInvitations(getDb(), ctx.businessId)
      : [];
    const overrides = canManageRoles
      ? await listMemberOverrides(getDb(), ctx.businessId)
      : [];

    // What the pickers may offer: the same rule `invite` and `setRole` enforce.
    const actor: Actor = ctx;
    const assignableCustomRoleIds = customRoles
      .filter(
        (role) =>
          ctx.businessRole === "owner" || holdsAll(ctx.permissions, role.permissions),
      )
      .map((role) => role.id);
    const roleEditableUserIds: string[] = [];
    if (canManageRoles) {
      for (const member of members) {
        if (member.userId === ctx.session.user.id) continue;
        if (await canChangeRoleOf(actor, member.userId)) {
          roleEditableUserIds.push(member.userId);
        }
      }
    }

    return {
      members,
      customRoles,
      invitations,
      overrides,
      role: ctx.businessRole,
      permissions: [...ctx.permissions],
      canInvite,
      canRemove: ctx.permissions.has("team.removeMember"),
      canManageRoles,
      assignableRoles: assignableRoles(ctx.businessRole, ctx.permissions),
      assignableCustomRoleIds,
      roleEditableUserIds,
    };
  }),

  invite: permissionProcedure("team.invite")
    .input(inviteInputSchema)
    .mutation(async ({ ctx, input }) => {
      const resolved = await resolveAssignableRole(ctx, input.role);
      const result = await inviteMember(getDb(), ctx.businessId, ctx.session.user.id, {
        email: input.email,
        ...resolved,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            result.reason === "already_member"
              ? "That person is already on your team"
              : "There's already a pending invite for that email - revoke it to send a new one",
        });
      }
      return result.invitation;
    }),

  revoke: permissionProcedure("team.invite")
    .input(z.object({ invitationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokeInvitation(
        getDb(),
        ctx.businessId,
        input.invitationId,
      );
      if (!revoked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No such pending invitation",
        });
      }
      return revoked;
    }),

  removeMember: permissionProcedure("team.removeMember")
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await getMemberOrThrow(ctx.businessId, input.userId);
      if (target.role === "owner" && ctx.businessRole !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an owner can remove another owner",
        });
      }
      const result = await removeMember(getDb(), ctx.businessId, input.userId);
      if (!result.ok) {
        throw new TRPCError({
          code:
            result.reason === "last_owner" ? "PRECONDITION_FAILED" : "NOT_FOUND",
          message:
            result.reason === "last_owner"
              ? "You can't remove the last owner - make someone else an owner first"
              : "That person isn't on your team",
        });
      }
      return { ok: true };
    }),

  // Change a member's role to a predefined or custom role. `role` is a
  // predefined key or a custom role id.
  setRole: permissionProcedure("team.manageRoles")
    .input(z.object({ userId: z.string(), role: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't change your own role",
        });
      }
      const target = await getMemberOrThrow(ctx.businessId, input.userId);
      if (target.role === "owner" && ctx.businessRole !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an owner can change an owner's role",
        });
      }
      if (!(await canChangeRoleOf(ctx, input.userId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You can't change this person's role - they have permissions you don't have yourself",
        });
      }

      const resolved = await resolveAssignableRole(ctx, input.role);

      const result =
        resolved.businessRoleId === null
          ? await setMemberRole(
              getDb(),
              ctx.businessId,
              input.userId,
              resolved.role as Exclude<StoredRole, "custom">,
            )
          : await setMemberCustomRole(
              getDb(),
              ctx.businessId,
              input.userId,
              resolved.businessRoleId,
            );

      if (!result.ok) {
        if (result.reason === "last_owner") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "You can't change the last owner's role - make someone else an owner first",
          });
        }
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That person isn't on your team",
        });
      }
      return { ok: true };
    }),

  setPermission: permissionProcedure("team.manageRoles")
    .input(
      z.object({
        userId: z.string(),
        permission: z
          .string()
          .refine(
            (value): value is Permission => PERMISSION_SET.has(value as Permission),
            "Unknown permission",
          ),
        effect: z.enum(["grant", "deny"]).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't change your own permissions",
        });
      }
      const target = await getMemberOrThrow(ctx.businessId, input.userId);
      if (target.role === "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Owners hold every permission and can't be overridden",
        });
      }
      if (input.effect === "grant" && !ctx.permissions.has(input.permission)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't grant a permission you don't have yourself",
        });
      }
      const result = await setMemberPermission(
        getDb(),
        ctx.businessId,
        input.userId,
        input.permission,
        input.effect,
      );
      if (!result.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That person isn't on your team",
        });
      }
      return { ok: true };
    }),

  // Custom role management. Creating or editing a role can only include
  // permissions the actor holds (anti-escalation), and a role still assigned
  // to someone can't be deleted.
  createRole: permissionProcedure("team.manageRoles")
    .input(z.object({ name: roleNameSchema, permissions: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const permissions = sanitizeRolePermissions(ctx.permissions, input.permissions);
      const result = await createCustomRole(
        getDb(),
        ctx.businessId,
        input.name,
        permissions,
      );
      if (!result.ok) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A role with that name already exists",
        });
      }
      return { id: result.id };
    }),

  updateRole: permissionProcedure("team.manageRoles")
    .input(
      z.object({
        roleId: z.string().uuid(),
        name: roleNameSchema,
        permissions: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const permissions = sanitizeRolePermissions(ctx.permissions, input.permissions);
      const result = await updateCustomRole(
        getDb(),
        ctx.businessId,
        input.roleId,
        input.name,
        permissions,
      );
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === "duplicate_name" ? "CONFLICT" : "NOT_FOUND",
          message:
            result.reason === "duplicate_name"
              ? "A role with that name already exists"
              : "No such role",
        });
      }
      return { ok: true };
    }),

  deleteRole: permissionProcedure("team.manageRoles")
    .input(z.object({ roleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await deleteCustomRole(getDb(), ctx.businessId, input.roleId);
      if (!result.ok) {
        throw new TRPCError({
          code: result.reason === "in_use" ? "PRECONDITION_FAILED" : "NOT_FOUND",
          message:
            result.reason === "in_use"
              ? "Reassign the members on this role before deleting it"
              : "No such role",
        });
      }
      return { ok: true };
    }),

  preview: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(({ input }) => getInvitationPreview(getDb(), input.token)),

  accept: authedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await acceptInvitation(
        getDb(),
        ctx.session.user.id,
        input.token,
      );
      if (!result.ok) {
        const message =
          result.reason === "expired"
            ? "This invite has expired - ask for a new one"
            : "This invite is no longer valid";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
      return result;
    }),
});
