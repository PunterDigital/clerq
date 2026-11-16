"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/server/trpc/client";

// Starts a read-only support view of the app as this user. The reason is
// required and goes into the audit history below.
export function ImpersonateControl({
  userId,
  disabledReason,
}: {
  userId: string;
  // Why viewing as this user isn't possible (yourself, another admin, a
  // suspended account), or null when it is.
  disabledReason: string | null;
}) {
  const trpc = useTRPC();
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");

  const start = useMutation(
    trpc.admin.startImpersonation.mutationOptions({
      // A full navigation: every server component has to render as the user.
      onSuccess: () => window.location.assign("/"),
    }),
  );

  if (disabledReason) {
    return <p className="text-sm text-muted-foreground">{disabledReason}</p>;
  }

  if (!expanded) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">
          See the app exactly as this user does, to diagnose a problem they reported.
          Read-only, ends after an hour, and recorded below.
        </p>
        <Button variant="outline" onClick={() => setExpanded(true)}>
          View as this user
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate({ userId, reason });
      }}
    >
      <label className="text-sm font-medium" htmlFor="impersonate-reason">
        Reason (kept in the audit history)
      </label>
      <Input
        id="impersonate-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Support ticket: invoice PDF shows the wrong total"
        maxLength={500}
        required
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={start.isPending || !reason.trim()}>
          Start viewing
        </Button>
        <Button type="button" variant="ghost" onClick={() => setExpanded(false)}>
          Cancel
        </Button>
      </div>
      {start.error && <p className="text-sm text-destructive">{start.error.message}</p>}
    </form>
  );
}
