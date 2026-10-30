import type { Metadata } from "next";
import { headers } from "next/headers";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { caller } from "@/server/trpc/server";

import { ApiKeysManager } from "./api-keys-manager";

export const metadata: Metadata = {
  title: "API - Clerq",
};

export const dynamic = "force-dynamic";

export default async function ApiSettingsPage() {
  // A key acts as its creator for whoever holds it, so the page is shown only
  // to callers who may manage keys (owners and admins by default).
  const session = await getAuth().api.getSession({ headers: await headers() });
  const membership = session
    ? await getActiveMembership(session.user.id)
    : null;
  if (!membership?.permissions.has("apiKeys.manage")) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Ask an owner or admin of this business for API access.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "app.useclerq.net";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const apiBase = `${proto}://${host}/api/v1`;

  const keys = await caller.apiKeys.list();

  return (
    <>
      <ApiKeysManager keys={keys} />
      <Card>
        <CardHeader>
          <CardTitle>Using a key</CardTitle>
          <CardDescription>
            Send the key in the Authorization header. A key works only in this
            business and can do what its creator can do; a read-only key can
            only read.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <code className="rounded-md bg-muted px-3 py-2 break-all">
            curl -H &quot;Authorization: Bearer clq_...&quot; {apiBase}/health
          </code>
          <p className="text-muted-foreground">
            The same key also works with the MCP endpoint at{" "}
            <code>/api/mcp</code>. Each key may make 120 requests a minute.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
