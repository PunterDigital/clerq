import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { getRequestSession, requestAuthLoaders } from "@/server/request-scope";

import { contextFromSession, createCallerFactory } from "./init";
import { appRouter } from "./routers/_app";

// tRPC runs the caller's context callback on every procedure call. Built
// once per request instead (React cache), on the same session the layout
// read, with loaders that share its suspension and membership checks
// (#5694): a page making six calls no longer repeats them six times.
const getRscContext = cache(async () =>
  contextFromSession(await headers(), await getRequestSession(), requestAuthLoaders),
);

// Direct server-side caller for React Server Components. Detached from the
// query client on purpose - RSC reads do not need hydration here yet.
export const caller = createCallerFactory(appRouter)(getRscContext);
