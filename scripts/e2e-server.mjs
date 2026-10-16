// Starts the production standalone server for the Playwright smoke tests.
// `next build` with output: "standalone" leaves .next/static and public/ for
// the deployer to copy next to server.js (the Dockerfile does the same), so
// do that first, then run the server in this process.
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const standalone = join(process.cwd(), ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("No standalone build found - run `pnpm build` first.");
  process.exit(1);
}

cpSync(join(".next", "static"), join(standalone, ".next", "static"), { recursive: true });
cpSync("public", join(standalone, "public"), { recursive: true });

process.chdir(standalone);
await import(pathToFileURL(join(standalone, "server.js")).href);
