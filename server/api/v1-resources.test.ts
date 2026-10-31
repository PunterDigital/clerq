import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, setTestDb, type Db } from "@/db";
import { createTestDatabase } from "@/db/testing";

import { createApiKey } from "@/server/api-keys";
import { resetRateLimits } from "./v1";

// The /api/v1 clients, projects and tasks endpoints against in-process
// Postgres (PGlite via the getDb() seam), calling the real route handlers the
// way Next does: a Request plus { params: Promise<...> }.

let pglite: PGlite;
let db: Db;

// "alice" owns business A and business B. writeA / readA are her keys in A;
// writeB is her key in B, used to make records A's keys must not reach.
let bizA = "";
let bizB = "";
let writeA = "";
let readA = "";
let writeB = "";

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
  const raw =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
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

const clientsRoute = () => import("@/app/api/v1/clients/route");
const clientRoute = () => import("@/app/api/v1/clients/[clientId]/route");
const archiveRoute = () => import("@/app/api/v1/clients/[clientId]/archive/route");
const unarchiveRoute = () => import("@/app/api/v1/clients/[clientId]/unarchive/route");
const notesRoute = () => import("@/app/api/v1/clients/[clientId]/notes/route");
const activityRoute = () => import("@/app/api/v1/clients/[clientId]/activity/route");
const projectsRoute = () => import("@/app/api/v1/projects/route");
const projectRoute = () => import("@/app/api/v1/projects/[projectId]/route");
const tasksRoute = () => import("@/app/api/v1/tasks/route");
const taskRoute = () => import("@/app/api/v1/tasks/[taskId]/route");
const statusRoute = () => import("@/app/api/v1/tasks/[taskId]/status/route");

async function makeClient(key: string, name: string): Promise<string> {
  const { POST } = await clientsRoute();
  const res = await call(POST, "POST", "/api/v1/clients", key, { body: { name } });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function makeProject(key: string, clientId: string, name: string): Promise<string> {
  const { POST } = await projectsRoute();
  const res = await call(POST, "POST", "/api/v1/projects", key, {
    body: { name, clientId },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function makeTask(key: string, projectId: string, title: string): Promise<string> {
  const { POST } = await tasksRoute();
  const res = await call(POST, "POST", "/api/v1/tasks", key, {
    body: { projectId, title },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-api-v1-resources";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  ({ pglite, db } = await createTestDatabase());
  setTestDb(db);

  await db.insert(schema.user).values({ id: "alice", name: "alice", email: "alice@t.dev" });
  const [a, b] = await db
    .insert(schema.business)
    .values([
      { name: "Business A", currency: "EUR" },
      { name: "Business B", currency: "EUR" },
    ])
    .returning();
  bizA = a.id;
  bizB = b.id;
  await db.insert(schema.businessMember).values([
    { businessId: bizA, userId: "alice", role: "owner" },
    { businessId: bizB, userId: "alice", role: "owner" },
  ]);
  await db.insert(schema.userActiveBusiness).values({ userId: "alice", businessId: bizA });

  const key = (businessId: string, scope: "read" | "write") =>
    createApiKey(db, { businessId, userId: "alice", name: scope, scope }).then((k) => k.key);
  writeA = await key(bizA, "write");
  readA = await key(bizA, "read");
  writeB = await key(bizB, "write");
});

afterAll(async () => {
  setTestDb(undefined);
  await pglite.close();
});

beforeEach(() => resetRateLimits());

describe("/api/v1/clients", () => {
  it("creates, lists, reads, patches, archives and unarchives a client", async () => {
    const { GET: list } = await clientsRoute();
    const { GET: get, PATCH } = await clientRoute();
    const id = await makeClient(writeA, "Acme Ltd");

    const listed = await call(list, "GET", "/api/v1/clients?search=acme", readA);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(listed.body.nextCursor).toBeNull();

    // PATCH changes only what it's sent.
    const set = await call(PATCH, "PATCH", `/api/v1/clients/${id}`, writeA, {
      params: { clientId: id },
      body: { contacts: [{ name: "Jo", email: "jo@acme.test" }], vatNumber: "CZ123" },
    });
    expect(set.status).toBe(200);
    const renamed = await call(PATCH, "PATCH", `/api/v1/clients/${id}`, writeA, {
      params: { clientId: id },
      body: { name: "Acme Group" },
    });
    expect(renamed.body).toMatchObject({
      name: "Acme Group",
      vatNumber: "CZ123",
      contacts: [{ name: "Jo", email: "jo@acme.test" }],
    });
    const cleared = await call(PATCH, "PATCH", `/api/v1/clients/${id}`, writeA, {
      params: { clientId: id },
      body: { vatNumber: null },
    });
    expect(cleared.body).toMatchObject({ name: "Acme Group", vatNumber: null });

    const { POST: archive } = await archiveRoute();
    expect(
      (await call(archive, "POST", `/api/v1/clients/${id}/archive`, writeA, { params: { clientId: id } }))
        .body.archivedAt,
    ).not.toBeNull();
    expect((await call(list, "GET", "/api/v1/clients?search=acme", readA)).body.data).toEqual([]);
    expect(
      (await call(list, "GET", "/api/v1/clients?search=acme&includeArchived=true", readA)).body.data,
    ).toHaveLength(1);
    const { POST: unarchive } = await unarchiveRoute();
    await call(unarchive, "POST", `/api/v1/clients/${id}/unarchive`, writeA, { params: { clientId: id } });

    const got = await call(get, "GET", `/api/v1/clients/${id}`, readA, { params: { clientId: id } });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, name: "Acme Group", archivedAt: null });
  });

  it("adds a note and lists it in the activity thread", async () => {
    const id = await makeClient(writeA, "Noted");
    const { POST } = await notesRoute();
    const note = await call(POST, "POST", `/api/v1/clients/${id}/notes`, writeA, {
      params: { clientId: id },
      body: { text: "Called about the renewal" },
    });
    expect(note.status).toBe(201);

    const { GET } = await activityRoute();
    const activity = await call(GET, "GET", `/api/v1/clients/${id}/activity?limit=1`, readA, {
      params: { clientId: id },
    });
    expect(activity.status).toBe(200);
    expect(activity.body.data).toHaveLength(1);
    expect(JSON.stringify(activity.body.data[0])).toContain("Called about the renewal");
    expect(activity.body.nextCursor).not.toBeNull(); // "created" is older
  });

  it("answers 404 for another business's client, or an id that isn't one", async () => {
    const other = await makeClient(writeB, "Client of B");
    const { GET, PATCH } = await clientRoute();
    for (const clientId of [other, "not-a-uuid"]) {
      const res = await call(GET, "GET", `/api/v1/clients/${clientId}`, readA, { params: { clientId } });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "not_found" } });
    }
    const patched = await call(PATCH, "PATCH", `/api/v1/clients/${other}`, writeA, {
      params: { clientId: other },
      body: { name: "Taken over" },
    });
    expect(patched.status).toBe(404);
    const { GET: list } = await clientsRoute();
    const listed = await call(list, "GET", "/api/v1/clients?includeArchived=true", readA);
    expect(listed.body.data.some((c: { id: string }) => c.id === other)).toBe(false);
  });

  it("refuses writes with a read-only key (403)", async () => {
    const id = await makeClient(writeA, "Read only");
    const { POST } = await clientsRoute();
    const { PATCH } = await clientRoute();
    const { POST: archive } = await archiveRoute();
    for (const res of [
      await call(POST, "POST", "/api/v1/clients", readA, { body: { name: "Nope" } }),
      // Invalid input still gets the 403: the scope is checked first.
      await call(POST, "POST", "/api/v1/clients", readA, { body: "not json" }),
      await call(PATCH, "PATCH", `/api/v1/clients/${id}`, readA, {
        params: { clientId: id },
        body: { name: "Nope" },
      }),
      await call(archive, "POST", `/api/v1/clients/${id}/archive`, readA, { params: { clientId: id } }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "forbidden" } });
    }
  });

  it("answers 422 for bad input and 400 for a body that isn't JSON", async () => {
    const { GET, POST } = await clientsRoute();
    const empty = await call(POST, "POST", "/api/v1/clients", writeA, { body: { name: "" } });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatchObject({ code: "validation_failed" });
    expect(empty.body.error.message).toMatch(/^name: /);
    const email = await call(POST, "POST", "/api/v1/clients", writeA, {
      body: { name: "X", contacts: [{ name: "Y", email: "not-an-email" }] },
    });
    expect(email.status).toBe(422);
    expect(email.body.error.message).toMatch(/^contacts\.0\.email: /);
    expect((await call(POST, "POST", "/api/v1/clients", writeA, { body: [] })).status).toBe(422);
    expect((await call(POST, "POST", "/api/v1/clients", writeA, { body: "{" })).status).toBe(400);
    expect(
      (await call(GET, "GET", "/api/v1/clients?includeArchived=yes", readA)).status,
    ).toBe(422);
  });
});

describe("/api/v1/projects", () => {
  it("creates, lists by client, reads and patches a project", async () => {
    const clientId = await makeClient(writeA, "Project client");
    const otherClient = await makeClient(writeA, "Other client");
    const { POST, GET: list } = await projectsRoute();
    const createdRes = await call(POST, "POST", "/api/v1/projects", writeA, {
      body: { name: "Website", clientId, dueDate: "2026-12-01", budgetMinor: 500000, budgetCurrency: "eur" },
    });
    expect(createdRes.status).toBe(201);
    const id = createdRes.body.id;
    expect(new Date(createdRes.body.dueDate).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    await makeProject(writeA, otherClient, "Elsewhere");

    const listed = await call(list, "GET", `/api/v1/projects?clientId=${clientId}`, readA);
    expect(listed.body.data.map((p: { id: string }) => p.id)).toEqual([id]);

    const { GET, PATCH } = await projectRoute();
    const patched = await call(PATCH, "PATCH", `/api/v1/projects/${id}`, writeA, {
      params: { projectId: id },
      body: { status: "on_hold" },
    });
    expect(patched.status).toBe(200);
    const got = await call(GET, "GET", `/api/v1/projects/${id}`, readA, { params: { projectId: id } });
    expect(got.body).toMatchObject({
      name: "Website",
      status: "on_hold",
      clientId,
      clientName: "Project client",
      budgetMinor: 500000,
      budgetCurrency: "EUR",
    });
    expect(new Date(got.body.dueDate).toISOString()).toBe("2026-12-01T00:00:00.000Z");

    const cleared = await call(PATCH, "PATCH", `/api/v1/projects/${id}`, writeA, {
      params: { projectId: id },
      body: { dueDate: null },
    });
    expect(cleared.body).toMatchObject({ dueDate: null, status: "on_hold" });
  });

  it("answers 404 for another business's project or client", async () => {
    const otherProject = await makeProject(writeB, await makeClient(writeB, "B client"), "B project");
    const { GET } = await projectRoute();
    expect(
      (await call(GET, "GET", `/api/v1/projects/${otherProject}`, readA, { params: { projectId: otherProject } }))
        .status,
    ).toBe(404);
    // A's key can't put a project under B's client either.
    const bClient = await makeClient(writeB, "B client 2");
    const { POST } = await projectsRoute();
    const res = await call(POST, "POST", "/api/v1/projects", writeA, {
      body: { name: "Sneaky", clientId: bClient },
    });
    expect(res.status).toBe(404);
  });

  it("refuses writes with a read-only key (403)", async () => {
    const clientId = await makeClient(writeA, "RO project client");
    const { POST } = await projectsRoute();
    const res = await call(POST, "POST", "/api/v1/projects", readA, { body: { name: "Nope", clientId } });
    expect(res.status).toBe(403);
  });

  it("answers 422 for bad input", async () => {
    const clientId = await makeClient(writeA, "Bad input client");
    const { POST, GET } = await projectsRoute();
    const badDate = await call(POST, "POST", "/api/v1/projects", writeA, {
      body: { name: "X", clientId, dueDate: "next tuesday" },
    });
    expect(badDate.status).toBe(422);
    expect(badDate.body.error.message).toBe("dueDate must be an ISO 8601 date");
    const noClient = await call(POST, "POST", "/api/v1/projects", writeA, { body: { name: "X" } });
    expect(noClient.status).toBe(422);
    expect(noClient.body.error.message).toMatch(/^clientId: /);
    const badStatus = await call(POST, "POST", "/api/v1/projects", writeA, {
      body: { name: "X", clientId, status: "paused" },
    });
    expect(badStatus.status).toBe(422);
    expect((await call(GET, "GET", "/api/v1/projects?clientId=nope", readA)).status).toBe(404);
  });
});

describe("/api/v1/tasks", () => {
  it("creates, lists, filters, searches, reads, patches, sets status and deletes tasks", async () => {
    const projectId = await makeProject(writeA, await makeClient(writeA, "Task client"), "Task project");
    const first = await makeTask(writeA, projectId, "Design the homepage");
    const second = await makeTask(writeA, projectId, "Build the homepage");

    const { GET: list } = await tasksRoute();
    const all = await call(list, "GET", `/api/v1/tasks?projectId=${projectId}`, readA);
    expect(all.body.data.map((t: { id: string }) => t.id)).toEqual([first, second]);
    expect(all.body.data[0]).toMatchObject({ status: "todo", trackedSeconds: 0 });

    const { POST: setStatus } = await statusRoute();
    const done = await call(setStatus, "POST", `/api/v1/tasks/${first}/status`, writeA, {
      params: { taskId: first },
      body: { status: "done" },
    });
    expect(done.body).toMatchObject({ id: first, status: "done" });
    const filtered = await call(list, "GET", `/api/v1/tasks?projectId=${projectId}&status=done`, readA);
    expect(filtered.body.data.map((t: { id: string }) => t.id)).toEqual([first]);

    const found = await call(list, "GET", "/api/v1/tasks?search=build", readA);
    expect(found.body.data).toEqual([
      expect.objectContaining({ id: second, projectName: "Task project", clientName: "Task client" }),
    ]);

    const { GET, PATCH, DELETE } = await taskRoute();
    // Patching the title keeps the status (the procedure would reset it to todo).
    const patched = await call(PATCH, "PATCH", `/api/v1/tasks/${first}`, writeA, {
      params: { taskId: first },
      body: { title: "Design the homepage v2", estimateMinutes: 90 },
    });
    expect(patched.body).toMatchObject({ title: "Design the homepage v2", status: "done", estimateMinutes: 90 });
    const got = await call(GET, "GET", `/api/v1/tasks/${first}`, readA, { params: { taskId: first } });
    expect(got.body).toMatchObject({ id: first, projectId, status: "done" });

    const deleted = await call(DELETE, "DELETE", `/api/v1/tasks/${second}`, writeA, { params: { taskId: second } });
    expect(deleted.status).toBe(200);
    expect(
      (await call(GET, "GET", `/api/v1/tasks/${second}`, readA, { params: { taskId: second } })).status,
    ).toBe(404);
  });

  it("answers 404 for another business's task or project", async () => {
    const bProject = await makeProject(writeB, await makeClient(writeB, "B task client"), "B task project");
    const bTask = await makeTask(writeB, bProject, "B task");
    const { GET, PATCH, DELETE } = await taskRoute();
    expect((await call(GET, "GET", `/api/v1/tasks/${bTask}`, readA, { params: { taskId: bTask } })).status).toBe(404);
    expect(
      (await call(PATCH, "PATCH", `/api/v1/tasks/${bTask}`, writeA, { params: { taskId: bTask }, body: { title: "x" } }))
        .status,
    ).toBe(404);
    expect((await call(DELETE, "DELETE", `/api/v1/tasks/${bTask}`, writeA, { params: { taskId: bTask } })).status).toBe(
      404,
    );
    const { POST, GET: list } = await tasksRoute();
    expect(
      (await call(POST, "POST", "/api/v1/tasks", writeA, { body: { projectId: bProject, title: "x" } })).status,
    ).toBe(404);
    expect((await call(list, "GET", "/api/v1/tasks?search=B task", readA)).body.data).toEqual([]);
    // B's task is still there.
    expect((await call(GET, "GET", `/api/v1/tasks/${bTask}`, writeB, { params: { taskId: bTask } })).status).toBe(200);
  });

  it("refuses writes with a read-only key (403)", async () => {
    const projectId = await makeProject(writeA, await makeClient(writeA, "RO task client"), "RO task project");
    const taskId = await makeTask(writeA, projectId, "Keep me");
    const { POST } = await tasksRoute();
    const { DELETE } = await taskRoute();
    const { POST: setStatus } = await statusRoute();
    for (const res of [
      await call(POST, "POST", "/api/v1/tasks", readA, { body: { projectId, title: "Nope" } }),
      await call(DELETE, "DELETE", `/api/v1/tasks/${taskId}`, readA, { params: { taskId } }),
      await call(setStatus, "POST", `/api/v1/tasks/${taskId}/status`, readA, {
        params: { taskId },
        body: { status: "done" },
      }),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it("answers 422 for bad input", async () => {
    const projectId = await makeProject(writeA, await makeClient(writeA, "422 task client"), "422 task project");
    const taskId = await makeTask(writeA, projectId, "Valid");
    const { GET, POST } = await tasksRoute();
    expect((await call(GET, "GET", "/api/v1/tasks", readA)).body.error.message).toBe("Pass projectId or search");
    expect((await call(GET, "GET", `/api/v1/tasks?projectId=${projectId}&status=later`, readA)).status).toBe(422);
    expect((await call(POST, "POST", "/api/v1/tasks", writeA, { body: { title: "No project" } })).status).toBe(422);
    const noTitle = await call(POST, "POST", "/api/v1/tasks", writeA, { body: { projectId } });
    expect(noTitle.status).toBe(422);
    expect(noTitle.body.error.message).toMatch(/^title: /);
    const { POST: setStatus } = await statusRoute();
    expect(
      (
        await call(setStatus, "POST", `/api/v1/tasks/${taskId}/status`, writeA, {
          params: { taskId },
          body: { status: "finished" },
        })
      ).status,
    ).toBe(422);
  });
});
