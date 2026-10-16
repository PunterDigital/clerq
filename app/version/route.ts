import { currentVersion } from "@/lib/version";

// The running build's version, public and uncached, so a deploy can be
// checked from outside: after a release, /version should report the new tag.
//
//   curl -fsS https://app.useclerq.net/version   # {"version":"1.4.0"}
//
// null for a source build (see lib/version.ts). Forced dynamic because
// `next build` runs in the image's builder stage, before CLERQ_VERSION is set
// in the runner stage: a prerendered response would always say null.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { version: currentVersion() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
