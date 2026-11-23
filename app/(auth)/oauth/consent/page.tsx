import { headers } from "next/headers";
import Image from "next/image";
import { redirect } from "next/navigation";

import { getConsentRequest } from "@/server/mcp/consent-request";
import { getEffectiveSession } from "@/server/session";

import { ConsentForm } from "./consent-form";

// Where an authenticated user approves (or denies) an MCP client that is
// trying to connect to their Clerq account. The Better Auth OAuth flow
// redirects here with a consent_code; approving posts back to the plugin's
// consent endpoint and returns to the client with an authorization code.
//
// What the card shows (the app's name and where it will send the user back)
// is read from the pending code in the database, not from the query string,
// so a crafted link can't make an attacker's app look like another one
// (#5579). A code that is missing, expired or belongs to someone else (also
// the case while a platform admin is viewing as another user) shows no
// Authorize button.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const consentCode = first(params.consent_code) ?? null;
  const scope = first(params.scope) ?? null;

  const session = await getEffectiveSession(await headers());
  if (!session) redirect("/sign-in");

  const request =
    consentCode && !session.impersonation
      ? await getConsentRequest(consentCode, session.user.id)
      : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <Image
        src="/brand/clerq-logo.svg"
        alt="Clerq"
        width={132}
        height={36}
        priority
      />
      <div className="w-full max-w-sm">
        <ConsentForm
          request={request}
          scope={scope}
          consentCode={request ? consentCode : null}
        />
      </div>
    </main>
  );
}
