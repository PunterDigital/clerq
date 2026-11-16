import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Support impersonation only works if every "who is signed in" read goes
// through getEffectiveSession (server/session.ts). A page or route that asks
// Better Auth directly would show the admin's own account mid-impersonation,
// and skip the read-only gate for non-tRPC writes.
const root = fileURLToPath(new URL("..", import.meta.url));
const allowed = new Set(["server/session.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("session reads", () => {
  it("go through getEffectiveSession, never Better Auth's getSession directly", () => {
    const offenders = ["app", "components", "modules", "server", "lib"]
      .flatMap((dir) => sourceFiles(join(root, dir)))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => readFileSync(join(root, rel), "utf8").includes("api.getSession("));
    expect(offenders).toEqual([]);
  });
});
