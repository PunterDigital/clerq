import { apiRoute } from "@/server/api/v1";

// GET /api/v1/timer - the key creator's running timer: { "timer": {...} },
// or { "timer": null } when none runs. A key acts as the person who made it,
// so these are always that person's timers.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (_req, { caller }) => ({
  timer: await caller.time.running(),
}));
