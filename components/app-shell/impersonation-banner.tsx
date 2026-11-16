"use client";

import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { useTRPC } from "@/server/trpc/client";

// Shown on every page while a platform admin is viewing the app as another
// user (modules/platform/impersonation.ts). Not dismissable: it is the only
// way out, and the reminder that nothing can be changed here.
export function ImpersonationBanner({
  userName,
  userEmail,
  expiresAt,
}: {
  userName: string;
  userEmail: string;
  expiresAt: Date;
}) {
  const trpc = useTRPC();
  const stop = useMutation(
    trpc.impersonation.stop.mutationOptions({
      // A full navigation, not router.push: every server component has to
      // re-render as the admin again.
      onSuccess: ({ targetUserId }) => {
        window.location.assign(`/system-admin/users/${targetUserId}`);
      },
      onError: () => window.location.assign("/system-admin/users"),
    }),
  );

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warning bg-warning-subtle px-4 py-2 text-sm text-warning-subtle-foreground sm:px-6"
    >
      <span>
        Viewing as <strong>{userName}</strong> ({userEmail}). Read-only: nothing can be
        changed. Ends {formatDateTime(expiresAt)}.
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={stop.isPending}
        onClick={() => stop.mutate()}
      >
        Stop viewing
      </Button>
    </div>
  );
}
