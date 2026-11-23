"use client";

import { useState } from "react";

import type { ConsentRequest } from "@/server/mcp/consent-request";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Posts the user's decision to the Better Auth `mcp` plugin consent endpoint
// and follows the redirect it returns (back to the connecting client). The
// session cookie is sent with the request, so the plugin knows who is
// approving; consent_code (when present) ties the approval to this exact
// pending authorization.
const CONSENT_ENDPOINT = "/api/auth/oauth2/consent";

function humaniseScope(scope: string): string {
  return scope
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.replace(/[_:]/g, " "))
    .join(", ");
}

export function ConsentForm({
  request,
  scope,
  consentCode,
}: {
  request: ConsentRequest | null;
  scope: string | null;
  consentCode: string | null;
}) {
  const [pending, setPending] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setError(null);
    setPending(accept ? "accept" : "deny");
    try {
      const res = await fetch(CONSENT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          accept,
          ...(consentCode ? { consent_code: consentCode } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`Consent failed (${res.status})`);
      }
      const data = (await res.json()) as { redirectURI?: string };
      if (data.redirectURI) {
        window.location.href = data.redirectURI;
        return;
      }
      throw new Error("No redirect returned");
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (!request || !consentCode) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>This request has expired</CardTitle>
          <CardDescription>
            Nothing was connected. Start connecting again from the app you
            want to use with Clerq.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorize access</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">
            {request.clientName}
          </span>{" "}
          wants to connect to your Clerq account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {scope ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">It will be able to:</p>
            <p>{humaniseScope(scope)}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            It will be able to read and manage your clients, projects, time and
            invoices.
          </p>
        )}
        <p className="text-sm text-muted-foreground" data-testid="consent-redirect">
          After you authorize, you go back to{" "}
          <span className="font-medium text-foreground">
            {request.redirectHost}
          </span>
          . Only authorize it if you started connecting this app yourself.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={pending !== null}
            onClick={() => decide(false)}
          >
            {pending === "deny" ? "Denying..." : "Deny"}
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={pending !== null}
            onClick={() => decide(true)}
          >
            {pending === "accept" ? "Authorizing..." : "Authorize"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
