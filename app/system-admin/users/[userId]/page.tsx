import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { getEffectiveSession } from "@/server/session";
import { caller } from "@/server/trpc/server";

import { AdminToggleControl } from "./admin-toggle-control";
import { ImpersonateControl } from "./impersonate-control";
import { SuspendUserControl } from "./suspend-user-control";

export const metadata: Metadata = {
  title: "User - System Administration - Clerq",
};

export const dynamic = "force-dynamic";

async function loadUser(userId: string) {
  try {
    return await caller.admin.getUser({ userId });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
}

export default async function SystemAdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const [user, session] = await Promise.all([
    loadUser(userId),
    getEffectiveSession(await headers()),
  ]);

  const isSelf = session?.user.id === user.id;
  const impersonateDisabled = isSelf
    ? "You can't view as yourself."
    : user.isPlatformAdmin
      ? "Platform admins can't be viewed as."
      : user.suspension
        ? "Reactivate this account to view as it."
        : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href="/system-admin/users"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Users
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl">{user.name}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Row label="Email" value={user.email} />
          <Row label="Email verified" value={user.emailVerified ? "Yes" : "No"} />
          <Row label="Signed up" value={formatDate(user.createdAt)} />
          <Row
            label="Status"
            value={
              user.suspension
                ? `Suspended ${formatDateTime(user.suspension.suspendedAt)}${
                    user.suspension.reason ? ` - ${user.suspension.reason}` : ""
                  }`
                : "Active"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Businesses</CardTitle>
        </CardHeader>
        <CardContent>
          {user.businesses.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not a member of any business.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {user.businesses.map((b) => (
                <li key={b.businessId} className="flex items-center justify-between text-sm">
                  <Link
                    href={`/system-admin/businesses/${b.businessId}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {b.name}
                  </Link>
                  <span className="text-muted-foreground">{b.roleName}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Moderation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SuspendUserControl userId={user.id} suspended={!!user.suspension} />
          <AdminToggleControl
            userId={user.id}
            isPlatformAdmin={user.isPlatformAdmin}
            isSelf={isSelf}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Support access</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ImpersonateControl userId={user.id} disabledReason={impersonateDisabled} />
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">History</h2>
            {user.impersonations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No one has viewed as this user.
              </p>
            ) : (
              <ul className="flex flex-col gap-3" data-testid="impersonation-history">
                {user.impersonations.map((i) => (
                  <li key={i.id} className="flex flex-col gap-0.5 text-sm">
                    <span>
                      <span className="font-medium">{i.adminName}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        - {formatDateTime(i.startedAt)}
                        {i.endedAt
                          ? ` to ${formatDateTime(i.endedAt)}${i.endedBy === "expired" ? " (expired)" : ""}`
                          : " (in progress)"}
                      </span>
                    </span>
                    <span className="text-muted-foreground">{i.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
