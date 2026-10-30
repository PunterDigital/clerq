import { currentVersion } from "@/lib/version";
import { apiRoute } from "@/server/api/v1";

// GET /api/v1/health - checks an API key end to end: it is valid, not revoked,
// within its rate limit, and its creator still belongs to the business. Returns
// which business and key the request ran as, so a script can confirm it is
// talking to the right place before it writes anything.
//
//   curl -H "Authorization: Bearer clq_..." https://app.useclerq.net/api/v1/health
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller, key }) => {
  const business = await caller.business.current();
  return {
    status: "ok",
    version: currentVersion(),
    business: { id: business.id, name: business.name },
    key: { id: key.id, name: key.name, scope: key.scope },
  };
});
