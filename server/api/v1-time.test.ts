import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";
import { createApiKey } from "@/server/api-keys";

import { resetRateLimits } from "./v1";

// The /api/v1 time-entries and timer endpoints against in-process Postgres
// (PGlite via the getDb() seam), calling the real route handlers the way Next
// does: a Request plus { params: Promise<...> }.

let pglite: PGlite;
let db: Db;

// "alice" owns business A and business B; "bob" is a member of A (time.viewAll
// but not reports.viewProfit). Keys: alice's write/read in A, bob's write in A,
// alice's write in B.
let aliceA = "";
let readA = "";
let bobA = "";
let aliceB = "";
let taskA = "";
let otherTaskA = "";
let taskB = "";

type Handler = (
  req: Request,
  segment?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type Result = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  handler: unknown,
  method: string,
  path: string,
  key: string,
  opts: { body?: unknown; params?: Record<string, string> } = {},
): Promise<Result> {
  const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await (handler as Handler)(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(raw === undefined ? {} : { "content-type": "application/json" }),
      },
      body: raw,
    }),
    opts.params ? { params: Promise.resolve(opts.params) } : undefined,
  );
  return { status: res.status, body: await res.json() };
}

const entriesRoute = () => import("@/app/api/v1/time-entries/route");
const entryRoute = () => import("@/app/api/v1/time-entries/[entryId]/route");
const timerRoute = () => import("@/app/api/v1/timer/route");
const startRoute = () => import("@/app/api/v1/timer/start/route");
const stopRoute = () => import("@/app/api/v1/timer/stop/route");

// A client, project and task made through the API itself.
async function makeTask(key: string, title: string): Promise<string> {
  const clients = await import("@/app/api/v1/clients/route");
  const projects = await import("@/app/api/v1/projects/route");
  const tasks = await import("@/app/api/v1/tasks/route");
  const client = await call(clients.POST, "POST", "/api/v1/clients", key, {
    body: { name: `${title} client`, defaultRateMinor: 10000, defaultRateCurrency: "EUR" },
  });
  const project = await call(projects.POST, "POST", "/api/v1/projects", key, {
    body: { name: `${title} project`, clientId: client.body.id },
  });
  const task = await call(tasks.POST, "POST", "/api/v1/tasks", key, {
    body: { projectId: project.body.id, title },
  });
  expect(task.status).toBe(201);
  return task.body.id;
}

async function logEntry(key: string, taskId: string, startedAt: string, note?: string) {
  const { POST } = await entriesRoute();
  return call(POST, "POST", "/api/v1/time-entries", key, {
    body: { taskId, startedAt, durationSeconds: 3600, note },
  });
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-api-v1-time";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db.insert(schema.user).values([
    { id: "alice", name: "alice", email: "alice@t.dev" },
    { id: "bob", name: "bob", email: "bob@t.dev" },
  ]);
  const [a, b] = await db
    .insert(schema.business)
    .values([
      { name: "Business A", currency: "EUR" },
      { name: "Business B", currency: "EUR" },
    ])
    .returning();
  await db.insert(schema.businessMember).values([
    { businessId: a.id, userId: "alice", role: "owner" },
    { businessId: b.id, userId: "alice", role: "owner" },
    { businessId: a.id, userId: "bob", role: "member" },
  ]);
  await db.insert(schema.userActiveBusiness).values({ userId: "alice", businessId: a.id });

  const key = (businessId: string, userId: string, scope: "read" | "write") =>
    createApiKey(db, { businessId, userId, name: scope, scope }).then((k) => k.key);
  aliceA = await key(a.id, "alice", "write");
  readA = await key(a.id, "alice", "read");
  bobA = await key(a.id, "bob", "write");
  aliceB = await key(b.id, "alice", "write");

  taskA = await makeTask(aliceA, "Task A");
  otherTaskA = await makeTask(aliceA, "Other task A");
  taskB = await makeTask(aliceB, "Task B");
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(() => resetRateLimits());

describe("/api/v1/timer", () => {
  it("starts, reports, switches and stops the key creator's timer", async () => {
    const { GET } = await timerRoute();
    const { POST: start } = await startRoute();
    const { POST: stop } = await stopRoute();

    expect((await call(GET, "GET", "/api/v1/timer", aliceA)).body).toEqual({ timer: null });

    const started = await call(start, "POST", "/api/v1/timer/start", aliceA, { body: { taskId: taskA } });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ taskId: taskA, userId: "alice", endedAt: null });

    const running = await call(GET, "GET", "/api/v1/timer", readA);
    expect(running.body.timer).toMatchObject({ id: started.body.id, taskTitle: "Task A" });

    // bob's key sees bob's (no) timer, not alice's.
    expect((await call(GET, "GET", "/api/v1/timer", bobA)).body).toEqual({ timer: null });

    // Starting on another task stops the first one.
    const switched = await call(start, "POST", "/api/v1/timer/start", aliceA, {
      body: { taskId: otherTaskA },
    });
    expect((await call(GET, "GET", "/api/v1/timer", aliceA)).body.timer.id).toBe(switched.body.id);

    const stopped = await call(stop, "POST", "/api/v1/timer/stop", aliceA);
    expect(stopped.status).toBe(200);
    expect(stopped.body.entry).toMatchObject({ id: switched.body.id, durationSeconds: expect.any(Number) });
    expect(stopped.body.entry.endedAt).not.toBeNull();
    expect((await call(stop, "POST", "/api/v1/timer/stop", aliceA)).body).toEqual({ entry: null });
    expect((await call(GET, "GET", "/api/v1/timer", aliceA)).body).toEqual({ timer: null });
  });
});

describe("/api/v1/time-entries", () => {
  it("logs, lists by task and by date range, edits the note and deletes", async () => {
    const logged = await logEntry(aliceA, taskA, "2026-03-01T09:00:00Z", "Kick-off");
    expect(logged.status).toBe(201);
    expect(logged.body).toMatchObject({
      taskId: taskA,
      durationSeconds: 3600,
      note: "Kick-off",
      billable: true,
      rateMinor: 10000,
    });
    const id = logged.body.id;
    await logEntry(aliceA, taskA, "2026-02-15T09:00:00Z", "Earlier");

    const { GET } = await entriesRoute();
    const byTask = await call(GET, "GET", `/api/v1/time-entries?taskId=${taskA}`, readA);
    expect(byTask.status).toBe(200);
    expect(byTask.body.data.map((e: { id: string }) => e.id)).toContain(id);

    const inMarch = "from=2026-03-01&to=2026-04-01";
    const taskInRange = await call(GET, "GET", `/api/v1/time-entries?taskId=${taskA}&${inMarch}`, readA);
    expect(taskInRange.body.data.map((e: { note: string }) => e.note)).toEqual(["Kick-off"]);
    const mine = await call(GET, "GET", `/api/v1/time-entries?${inMarch}`, readA);
    expect(mine.body.data).toEqual([
      expect.objectContaining({ id, taskTitle: "Task A", projectName: "Task A project", clientName: "Task A client" }),
    ]);
    // bob's own entries don't include alice's.
    expect((await call(GET, "GET", `/api/v1/time-entries?${inMarch}`, bobA)).body.data).toEqual([]);

    const { PATCH, DELETE } = await entryRoute();
    const noted = await call(PATCH, "PATCH", `/api/v1/time-entries/${id}`, aliceA, {
      params: { entryId: id },
      body: { note: "Kick-off call" },
    });
    expect(noted.body).toMatchObject({ id, note: "Kick-off call", durationSeconds: 3600 });
    const cleared = await call(PATCH, "PATCH", `/api/v1/time-entries/${id}`, aliceA, {
      params: { entryId: id },
      body: { note: null },
    });
    expect(cleared.body.note).toBeNull();

    const deleted = await call(DELETE, "DELETE", `/api/v1/time-entries/${id}`, aliceA, { params: { entryId: id } });
    expect(deleted.status).toBe(200);
    expect((await call(GET, "GET", `/api/v1/time-entries?${inMarch}`, readA)).body.data).toEqual([]);
    expect(
      (await call(DELETE, "DELETE", `/api/v1/time-entries/${id}`, aliceA, { params: { entryId: id } })).status,
    ).toBe(404);
  });

  it("shows internal cost only to keys whose creator may view profit", async () => {
    const asBob = await logEntry(bobA, taskA, "2026-08-01T09:00:00Z");
    expect(asBob.status).toBe(201);
    expect(asBob.body).not.toHaveProperty("internalCostMinor");
    expect(asBob.body).not.toHaveProperty("internalCostCurrency");

    const { GET } = await entriesRoute();
    const bobList = await call(GET, "GET", `/api/v1/time-entries?taskId=${taskA}`, bobA);
    expect(bobList.body.data.length).toBeGreaterThan(0);
    for (const entry of bobList.body.data) expect(entry).not.toHaveProperty("internalCostMinor");

    const aliceList = await call(GET, "GET", `/api/v1/time-entries?taskId=${taskA}`, aliceA);
    for (const entry of aliceList.body.data) expect(entry).toHaveProperty("internalCostMinor");
  });

  it("answers 404 for another business's task or entry", async () => {
    const { POST: start } = await startRoute();
    expect((await call(start, "POST", "/api/v1/timer/start", aliceA, { body: { taskId: taskB } })).status).toBe(404);
    expect((await logEntry(aliceA, taskB, "2026-10-02T09:00:00Z")).status).toBe(404);

    const inB = await logEntry(aliceB, taskB, "2026-10-02T09:00:00Z", "B only");
    const { PATCH, DELETE } = await entryRoute();
    for (const res of [
      await call(PATCH, "PATCH", `/api/v1/time-entries/${inB.body.id}`, aliceA, {
        params: { entryId: inB.body.id },
        body: { note: "taken over" },
      }),
      await call(DELETE, "DELETE", `/api/v1/time-entries/${inB.body.id}`, aliceA, {
        params: { entryId: inB.body.id },
      }),
      await call(PATCH, "PATCH", "/api/v1/time-entries/nope", aliceA, {
        params: { entryId: "nope" },
        body: { note: "x" },
      }),
    ]) {
      expect(res.status).toBe(404);
    }
    const { GET } = await entriesRoute();
    expect((await call(GET, "GET", `/api/v1/time-entries?taskId=${taskB}`, readA)).body.data).toEqual([]);
    // Still there in B.
    expect((await call(GET, "GET", `/api/v1/time-entries?taskId=${taskB}`, aliceB)).body.data).toHaveLength(1);
  });

  it("refuses writes with a read-only key (403)", async () => {
    const { POST } = await entriesRoute();
    const { PATCH, DELETE } = await entryRoute();
    const { POST: start } = await startRoute();
    const { POST: stop } = await stopRoute();
    const entry = await logEntry(aliceA, taskA, "2026-07-01T09:00:00Z");
    const params = { entryId: entry.body.id };
    for (const res of [
      await call(POST, "POST", "/api/v1/time-entries", readA, {
        body: { taskId: taskA, startedAt: "2026-07-01T09:00:00Z", durationSeconds: 60 },
      }),
      await call(PATCH, "PATCH", `/api/v1/time-entries/${params.entryId}`, readA, { params, body: { note: "x" } }),
      await call(DELETE, "DELETE", `/api/v1/time-entries/${params.entryId}`, readA, { params }),
      await call(start, "POST", "/api/v1/timer/start", readA, { body: { taskId: taskA } }),
      await call(stop, "POST", "/api/v1/timer/stop", readA),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it("answers 422 for bad input", async () => {
    const { GET, POST } = await entriesRoute();
    const get = async (query: string) => call(GET, "GET", `/api/v1/time-entries${query}`, readA);
    expect((await get("")).body.error.message).toBe("Pass taskId, or from and to");
    expect((await get("?from=2026-10-01")).body.error.message).toBe("Pass both from and to, or neither");
    expect((await get("?from=2026-11-01&to=2026-10-01")).status).toBe(422);
    expect((await get("?from=soon&to=2026-10-01")).body.error.message).toBe("from must be an ISO 8601 date");

    const post = async (body: unknown) => call(POST, "POST", "/api/v1/time-entries", aliceA, { body });
    expect((await post({ taskId: taskA, startedAt: "2026-10-01T09:00:00Z", durationSeconds: 0 })).body.error.message).toMatch(
      /^durationSeconds: /,
    );
    expect((await post({ taskId: taskA, durationSeconds: 60 })).body.error.message).toMatch(/^startedAt: /);
    expect((await post({ taskId: taskA, startedAt: "yesterday", durationSeconds: 60 })).status).toBe(422);

    const { POST: start } = await startRoute();
    expect((await call(start, "POST", "/api/v1/timer/start", aliceA, { body: {} })).body.error.message).toMatch(
      /^taskId: /,
    );
    const { PATCH } = await entryRoute();
    const entry = await logEntry(aliceA, taskA, "2026-06-01T09:00:00Z");
    expect(
      (
        await call(PATCH, "PATCH", `/api/v1/time-entries/${entry.body.id}`, aliceA, {
          params: { entryId: entry.body.id },
          body: { note: 42 },
        })
      ).status,
    ).toBe(422);
  });
});
