import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { redirect } from "next/navigation";

import { ImpersonationBanner } from "@/components/app-shell/impersonation-banner";
import { getEffectiveSession } from "@/server/session";
import { getActiveMembership } from "@/server/membership";

import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = {
  title: "Set up your business - Clerq",
};

// Per-request: session check + DB lookup, never prerenderable.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getEffectiveSession(await headers());
  if (!session) {
    redirect("/sign-in");
  }
  const membership = await getActiveMembership(session.user.id);
  if (membership) {
    redirect("/");
  }

  return (
    <>
      {session.impersonation ? (
        <ImpersonationBanner
          userName={session.user.name}
          userEmail={session.user.email}
          expiresAt={session.impersonation.expiresAt}
        />
      ) : null}
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <Image
        src="/brand/clerq-logo.svg"
        alt="Clerq"
        width={132}
        height={36}
        priority
      />
      <div className="w-full max-w-sm">
        <OnboardingForm />
      </div>
    </main>
    </>
  );
}
