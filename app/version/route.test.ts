import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the version baked into the image", async () => {
    vi.stubEnv("CLERQ_VERSION", "1.4.0");
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "1.4.0" });
  });

  it("reports null for a source build", async () => {
    vi.stubEnv("CLERQ_VERSION", "");
    expect(await GET().json()).toEqual({ version: null });
  });

  it("is never cached, so it always reflects the running deploy", () => {
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });
});
