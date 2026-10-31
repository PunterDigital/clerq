import { z } from "zod";

import { apiRoute, created, idParam, readBody } from "@/server/api/v1";

// POST /api/v1/clients/:clientId/notes - add a note ({ "text": "..." }) to the
// client's activity thread.
export const dynamic = "force-dynamic";

const noteSchema = z.object({ text: z.string() });

export const POST = apiRoute<{ clientId: string }>(async (req, { caller, params }) => {
  const clientId = idParam(params.clientId, "client");
  const { text } = noteSchema.parse(await readBody(req));
  return created(await caller.clients.addNote({ clientId, text }));
});
