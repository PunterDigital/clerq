import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getEffectiveSession } from "@/server/session";
import { caller } from "@/server/trpc/server";

import { AcceptForm } from "./accept-form";

export const metadata: Metadata = {
  title: "Join a team - Clerq",
};

// Lives outside the (app) group on purpose: an invited user may have no
// business yet, and (app) would bounce them to /onboarding. This screen
// owns its own auth branching instead.
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <Image
        src="/brand/clerq-logo.svg"
        alt="Clerq"
        width={132}
        height={36}
        priority
      />
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [session, preview] = await Promise.all([
    getEffectiveSession(await headers()),
    caller.team.preview({ token }),
  ]);

  if (!preview) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Invite not found</CardTitle>
            <CardDescription>
              This invite link is invalid. Ask whoever invited you for a fresh
              one.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  if (!preview.valid) {
    const reason =
      preview.status === "accepted"
        ? "This invite has already been accepted."
        : preview.status === "revoked"
          ? "This invite was revoked."
          : "This invite has expired.";
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Invite unavailable</CardTitle>
            <CardDescription>
              {reason} Ask {preview.businessName} for a new one.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  // Valid invite, but the visitor isn't signed in: send them to auth and back.
  if (!session) {
    const redirectTo = `/invite/${token}`;
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Join {preview.businessName}</CardTitle>
            <CardDescription>
              You&apos;ve been invited to join{" "}
              <span className="font-medium text-foreground">
                {preview.businessName}
              </span>{" "}
              as a {preview.role}. Sign in or create an account to accept -
              ideally with {preview.email}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <Button asChild>
              <Link
                href={`/sign-up?redirect=${encodeURIComponent(redirectTo)}`}
              >
                Create an account
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link
                href={`/sign-in?redirect=${encodeURIComponent(redirectTo)}`}
              >
                Sign in
              </Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Join {preview.businessName}</CardTitle>
          <CardDescription>
            You&apos;re joining{" "}
            <span className="font-medium text-foreground">
              {preview.businessName}
            </span>{" "}
            as a {preview.role}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AcceptForm token={token} businessName={preview.businessName} />
        </CardContent>
      </Card>
    </Shell>
  );
}
