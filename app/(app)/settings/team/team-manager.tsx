"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";
import {
  isRole,
  PERMISSION_GROUPS,
  PERMISSION_META,
  PERMISSIONS,
  permissionsForRole,
  ROLE_META,
  type Permission,
  type PermissionEffect,
  type Role,
  type StoredRole,
} from "@/modules/authz";
import { useTRPC } from "@/server/trpc/client";

type CustomRole = { id: string; name: string; permissions: Permission[] };
type Member = {
  businessMemberId: string;
  userId: string;
  name: string;
  email: string;
  role: StoredRole;
  businessRoleId: string | null;
  joinedAt: Date;
};
type Invitation = {
  id: string;
  email: string;
  role: StoredRole;
  businessRoleId: string | null;
  token: string;
  expiresAt: Date;
};
type Override = {
  businessMemberId: string;
  permission: string;
  effect: PermissionEffect;
};

// Resolve a member/invitation's role to a human label given the custom roles.
function roleLabel(
  role: StoredRole,
  businessRoleId: string | null,
  customRoles: CustomRole[],
): string {
  if (role === "custom") {
    return customRoles.find((r) => r.id === businessRoleId)?.name ?? "Custom role";
  }
  return ROLE_META[role].label;
}

// The base permission set a role grants, for the override editor's hints.
function baselineFor(member: Member, customRoles: CustomRole[]): Set<Permission> {
  if (member.role === "custom") {
    const role = customRoles.find((r) => r.id === member.businessRoleId);
    return new Set(role?.permissions ?? []);
  }
  return isRole(member.role) ? permissionsForRole(member.role) : new Set();
}

export function TeamManager({
  members,
  invitations,
  overrides,
  customRoles,
  currentUserId,
  canInvite,
  canRemove,
  canManageRoles,
  assignableRoles,
  assignableCustomRoleIds,
  roleEditableUserIds,
}: {
  members: Member[];
  invitations: Invitation[];
  overrides: Override[];
  customRoles: CustomRole[];
  currentUserId: string;
  canInvite: boolean;
  canRemove: boolean;
  canManageRoles: boolean;
  assignableRoles: Role[];
  assignableCustomRoleIds: string[];
  roleEditableUserIds: string[];
}) {
  const assignable: Assignable = {
    roles: assignableRoles,
    customRoleIds: assignableCustomRoleIds,
  };
  return (
    <div className="flex flex-col gap-6">
      {canInvite ? (
        <InviteCard assignable={assignable} customRoles={customRoles} />
      ) : null}
      {canInvite && invitations.length > 0 ? (
        <PendingInvites invitations={invitations} customRoles={customRoles} />
      ) : null}
      <MembersCard
        members={members}
        overrides={overrides}
        customRoles={customRoles}
        currentUserId={currentUserId}
        canRemove={canRemove}
        canManageRoles={canManageRoles}
        assignable={assignable}
        roleEditableUserIds={roleEditableUserIds}
      />
      {canManageRoles ? <CustomRolesCard customRoles={customRoles} /> : null}
    </div>
  );
}

// The roles the viewer may hand out (the server's `team.list` works this out
// with the same rule `invite` and `setRole` enforce: only roles whose
// permissions the viewer holds themselves).
type Assignable = { roles: Role[]; customRoleIds: string[] };

// Build the option list for a role <select>: the assignable predefined roles
// plus the assignable custom roles. Option values are role keys or custom role
// ids. `current` (a member's role) stays selectable so the select shows it.
function roleOptions(
  assignable: Assignable,
  customRoles: CustomRole[],
  current: { role: StoredRole; businessRoleId: string | null } | null,
) {
  const options: { value: string; label: string }[] = assignable.roles.map((r) => ({
    value: r,
    label: ROLE_META[r].label,
  }));
  if (current && current.role !== "custom" && !assignable.roles.includes(current.role)) {
    options.unshift({ value: current.role, label: ROLE_META[current.role].label });
  }
  for (const role of customRoles) {
    const isCurrent =
      current?.role === "custom" && current.businessRoleId === role.id;
    if (isCurrent || assignable.customRoleIds.includes(role.id)) {
      options.push({ value: role.id, label: role.name });
    }
  }
  return options;
}

function currentRoleValue(member: {
  role: StoredRole;
  businessRoleId: string | null;
}) {
  return member.role === "custom" ? (member.businessRoleId ?? "") : member.role;
}

function InviteCard({
  assignable,
  customRoles,
}: {
  assignable: Assignable;
  customRoles: CustomRole[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [email, setEmail] = useState("");
  const options = roleOptions(assignable, customRoles, null);
  const [inviteRole, setInviteRole] = useState<string>(
    options.some((o) => o.value === "member") ? "member" : (options[0]?.value ?? ""),
  );

  const invite = useMutation(
    trpc.team.invite.mutationOptions({
      onSuccess: () => {
        setEmail("");
        router.refresh();
      },
    }),
  );

  const description = !inviteRole
    ? "There is no role you can invite people as: you can only hand out a role whose permissions you all hold yourself."
    : isRole(inviteRole)
      ? ROLE_META[inviteRole].description
      : `Custom role: ${customRoles.find((r) => r.id === inviteRole)?.name ?? ""}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a team member</CardTitle>
        <CardDescription>
          Send them the invite link to join your business. The link is valid
          for 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate({ email: email.trim(), role: inviteRole });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              placeholder="teammate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="h-9 w-48 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {invite.error ? (
            <p role="alert" className="text-sm text-destructive">
              {invite.error.message}
            </p>
          ) : null}
          <div>
            <Button
              type="submit"
              disabled={invite.isPending || !email.trim() || !inviteRole}
            >
              {invite.isPending ? "Creating invite..." : "Create invite"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PendingInvites({
  invitations,
  customRoles,
}: {
  invitations: Invitation[];
  customRoles: CustomRole[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
        <CardDescription>
          Share the link with each person - they join once they accept.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {invitations.map((inv) => (
          <InviteRow key={inv.id} invitation={inv} customRoles={customRoles} />
        ))}
      </CardContent>
    </Card>
  );
}

function InviteRow({
  invitation,
  customRoles,
}: {
  invitation: Invitation;
  customRoles: CustomRole[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [copied, setCopied] = useState(false);

  const revoke = useMutation(
    trpc.team.revoke.mutationOptions({ onSuccess: () => router.refresh() }),
  );

  function copyLink() {
    const url = `${window.location.origin}/invite/${invitation.token}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{invitation.email}</div>
        <div className="text-xs text-muted-foreground">
          {roleLabel(invitation.role, invitation.businessRoleId, customRoles)} ·
          expires {formatDate(invitation.expiresAt)}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={copyLink}>
        {copied ? "Copied!" : "Copy link"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate({ invitationId: invitation.id })}
        className="text-muted-foreground hover:text-destructive"
      >
        Revoke
      </Button>
    </div>
  );
}

function MembersCard({
  members,
  overrides,
  customRoles,
  currentUserId,
  canRemove,
  canManageRoles,
  assignable,
  roleEditableUserIds,
}: {
  members: Member[];
  overrides: Override[];
  customRoles: CustomRole[];
  currentUserId: string;
  canRemove: boolean;
  canManageRoles: boolean;
  assignable: Assignable;
  roleEditableUserIds: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          {members.length} {members.length === 1 ? "person" : "people"} on your
          team
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            overrides={overrides.filter(
              (o) => o.businessMemberId === member.businessMemberId,
            )}
            customRoles={customRoles}
            isSelf={member.userId === currentUserId}
            canRemove={canRemove}
            canManageRoles={canManageRoles}
            canChangeRole={roleEditableUserIds.includes(member.userId)}
            assignable={assignable}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  overrides,
  customRoles,
  isSelf,
  canRemove,
  canManageRoles,
  canChangeRole,
  assignable,
}: {
  member: Member;
  overrides: Override[];
  customRoles: CustomRole[];
  isSelf: boolean;
  canRemove: boolean;
  canManageRoles: boolean;
  // From the server: false for an owner (unless the viewer is one) and for
  // anyone holding permissions the viewer lacks.
  canChangeRole: boolean;
  assignable: Assignable;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [expanded, setExpanded] = useState(false);

  const remove = useMutation(
    trpc.team.removeMember.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );
  const setRole = useMutation(
    trpc.team.setRole.mutationOptions({ onSuccess: () => router.refresh() }),
  );

  const canEditRole = canManageRoles && canChangeRole && !isSelf;
  const canEditPermissions = canManageRoles && !isSelf && member.role !== "owner";
  const options = roleOptions(assignable, customRoles, member);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{member.name}</span>
            {isSelf ? (
              <span className="text-xs text-muted-foreground">(you)</span>
            ) : null}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {member.email}
          </div>
        </div>

        {canEditRole ? (
          <select
            value={currentRoleValue(member)}
            disabled={setRole.isPending}
            onChange={(e) =>
              setRole.mutate({ userId: member.userId, role: e.target.value })
            }
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="shrink-0 rounded-full bg-[var(--status-draft-bg)] px-2 py-px text-xs font-semibold text-[var(--status-draft-fg)]">
            {roleLabel(member.role, member.businessRoleId, customRoles)}
          </span>
        )}

        {canEditPermissions ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : "Permissions"}
          </Button>
        ) : null}

        {canRemove && !isSelf ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ userId: member.userId })}
            className="text-muted-foreground hover:text-destructive"
          >
            Remove
          </Button>
        ) : null}
      </div>

      {(setRole.error || remove.error) && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {setRole.error?.message ?? remove.error?.message}
        </p>
      )}

      {expanded && canEditPermissions ? (
        <PermissionEditor
          member={member}
          overrides={overrides}
          baseline={baselineFor(member, customRoles)}
        />
      ) : null}
    </div>
  );
}

function PermissionEditor({
  member,
  overrides,
  baseline,
}: {
  member: Member;
  overrides: Override[];
  baseline: Set<Permission>;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const setPermission = useMutation(
    trpc.team.setPermission.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );

  const overrideFor = new Map<string, PermissionEffect>(
    overrides.map((o) => [o.permission, o.effect]),
  );

  return (
    <div className="border-t px-3 py-3">
      <p className="mb-3 text-xs text-muted-foreground">
        Overrides layer on top of the role. Inherit follows the role; deny
        always wins.
      </p>
      <div className="flex flex-col gap-4">
        {PERMISSION_GROUPS.map((group) => {
          const perms = PERMISSIONS.filter(
            (p) => PERMISSION_META[p].group === group,
          );
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold">{group}</div>
              {perms.map((permission) => {
                const state = overrideFor.get(permission) ?? "inherit";
                const roleHas = baseline.has(permission);
                return (
                  <div
                    key={permission}
                    className="flex items-center gap-3 text-xs"
                  >
                    <span className="flex-1 text-muted-foreground">
                      {PERMISSION_META[permission].label}
                      <span className="ml-1 opacity-60">
                        ({roleHas ? "role: allowed" : "role: denied"})
                      </span>
                    </span>
                    <div className="flex gap-1">
                      {(["inherit", "grant", "deny"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          disabled={setPermission.isPending}
                          onClick={() =>
                            setPermission.mutate({
                              userId: member.userId,
                              permission,
                              effect: option === "inherit" ? null : option,
                            })
                          }
                          className={`rounded border px-2 py-0.5 capitalize ${
                            state === option
                              ? "border-ring bg-accent font-medium"
                              : "border-transparent text-muted-foreground hover:border-border"
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {setPermission.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {setPermission.error.message}
        </p>
      ) : null}
    </div>
  );
}

// Create, edit and delete the business's own roles.
function CustomRolesCard({ customRoles }: { customRoles: CustomRole[] }) {
  const [creating, setCreating] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom roles</CardTitle>
        <CardDescription>
          Define your own roles as a named set of permissions, then assign them
          to members like any predefined role.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {customRoles.length === 0 && !creating ? (
          <p className="text-sm text-muted-foreground">No custom roles yet.</p>
        ) : null}
        {customRoles.map((role) => (
          <CustomRoleRow key={role.id} role={role} />
        ))}
        {creating ? (
          <RoleEditor onDone={() => setCreating(false)} />
        ) : (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
            >
              New role
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CustomRoleRow({ role }: { role: CustomRole }) {
  const router = useRouter();
  const trpc = useTRPC();
  const [editing, setEditing] = useState(false);
  const remove = useMutation(
    trpc.team.deleteRole.mutationOptions({ onSuccess: () => router.refresh() }),
  );

  if (editing) {
    return <RoleEditor role={role} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{role.name}</div>
        <div className="text-xs text-muted-foreground">
          {role.permissions.length}{" "}
          {role.permissions.length === 1 ? "permission" : "permissions"}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={remove.isPending}
        onClick={() => remove.mutate({ roleId: role.id })}
        className="text-muted-foreground hover:text-destructive"
      >
        Delete
      </Button>
      {remove.error ? (
        <p role="alert" className="text-xs text-destructive">
          {remove.error.message}
        </p>
      ) : null}
    </div>
  );
}

function RoleEditor({
  role,
  onDone,
}: {
  role?: CustomRole;
  onDone: () => void;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState(role?.name ?? "");
  const [selected, setSelected] = useState<Set<Permission>>(
    new Set(role?.permissions ?? []),
  );

  const create = useMutation(
    trpc.team.createRole.mutationOptions({
      onSuccess: () => {
        onDone();
        router.refresh();
      },
    }),
  );
  const update = useMutation(
    trpc.team.updateRole.mutationOptions({
      onSuccess: () => {
        onDone();
        router.refresh();
      },
    }),
  );
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  function toggle(permission: Permission) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  function save() {
    const permissions = [...selected];
    if (role) update.mutate({ roleId: role.id, name: name.trim(), permissions });
    else create.mutate({ name: name.trim(), permissions });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="role-name">Role name</Label>
        <Input
          id="role-name"
          value={name}
          placeholder="e.g. Bookkeeper"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-3">
        {PERMISSION_GROUPS.map((group) => {
          const perms = PERMISSIONS.filter(
            (p) => PERMISSION_META[p].group === group,
          );
          return (
            <div key={group} className="flex flex-col gap-1">
              <div className="text-xs font-semibold">{group}</div>
              {perms.map((permission) => (
                <label
                  key={permission}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(permission)}
                    onChange={() => toggle(permission)}
                  />
                  {PERMISSION_META[permission].label}
                </label>
              ))}
            </div>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending || !name.trim()} onClick={save}>
          {pending ? "Saving..." : role ? "Save changes" : "Create role"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
