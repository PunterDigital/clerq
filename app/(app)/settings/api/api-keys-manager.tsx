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
import { useTRPC } from "@/server/trpc/client";

type ApiKey = {
  id: string;
  name: string;
  scope: "read" | "write";
  keyPrefix: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const SCOPE_LABEL = {
  read: "Read only",
  write: "Read and write",
} as const;

export function ApiKeysManager({ keys }: { keys: ApiKey[] }) {
  const live = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);

  return (
    <>
      <CreateKey />
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Keys for scripts and other apps. Revoke a key as soon as it is no
            longer needed or may have leaked.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {live.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            live.map((key) => <KeyRow key={key.id} apiKey={key} />)
          )}
          {revoked.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Revoked keys ({revoked.length})
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {revoked.map((key) => (
                  <KeyRow key={key.id} apiKey={key} />
                ))}
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function CreateKey() {
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const create = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (result) => {
        setCreated({ name: name.trim(), key: result.key });
        setName("");
        router.refresh();
      },
    }),
  );

  function copyKey() {
    if (!created) return;
    void navigator.clipboard.writeText(created.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an API key</CardTitle>
        <CardDescription>
          The key works only in this business and acts as you. You see it once,
          right after you create it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {created ? (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-md border px-3 py-2.5"
          >
            <p className="text-sm font-medium">
              Copy the key for &quot;{created.name}&quot; now. You won&apos;t
              see it again.
            </p>
            <code
              data-testid="new-api-key"
              className="rounded-md bg-muted px-3 py-2 text-sm break-all"
            >
              {created.key}
            </code>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyKey}>
                {copied ? "Copied!" : "Copy key"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreated(null)}
              >
                Done
              </Button>
            </div>
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ name: name.trim(), scope });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              required
              maxLength={80}
              placeholder="Panel sync"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key-scope">Access</Label>
            <select
              id="api-key-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "read" | "write")}
              className="h-9 w-48 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              <option value="read">{SCOPE_LABEL.read}</option>
              <option value="write">{SCOPE_LABEL.write}</option>
            </select>
          </div>
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              {create.error.message}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Creating key..." : "Create key"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const router = useRouter();
  const trpc = useTRPC();
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation(
    trpc.apiKeys.revoke.mutationOptions({ onSuccess: () => router.refresh() }),
  );

  const usage = apiKey.revokedAt
    ? `revoked ${formatDate(apiKey.revokedAt)}`
    : apiKey.lastUsedAt
      ? `last used ${formatDate(apiKey.lastUsedAt)}`
      : "never used";

  return (
    <div
      data-testid="api-key-row"
      className="flex items-center gap-3 rounded-md border px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{apiKey.name}</div>
        <div className="text-xs text-muted-foreground">
          <code>{apiKey.keyPrefix}...</code> · {SCOPE_LABEL[apiKey.scope]} ·
          created by {apiKey.createdBy} {formatDate(apiKey.createdAt)} · {usage}
        </div>
        {revoke.error ? (
          <p role="alert" className="text-xs text-destructive">
            {revoke.error.message}
          </p>
        ) : null}
      </div>
      {apiKey.revokedAt ? null : confirming ? (
        <>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ keyId: apiKey.id })}
          >
            {revoke.isPending ? "Revoking..." : "Confirm revoke"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}
