// Checks run once when the server boots (instrumentation.ts), #5584.

// The fallback docker-compose.yml uses when BETTER_AUTH_SECRET isn't set.
// Anyone can read it in the repo, so with it they can forge sessions and
// PDF links on any instance that kept it.
export const COMPOSE_DEFAULT_SECRET = "clerq-dev-secret-change-me";

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

// Why the server must not start with this environment, or null. The
// compose default stays allowed while the instance only answers on
// localhost (trying Clerq out); served anywhere else it's refused.
export function insecureSecretProblem(env: {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
}): string | null {
  if (env.BETTER_AUTH_SECRET !== COMPOSE_DEFAULT_SECRET) return null;
  if (isLocalUrl(env.BETTER_AUTH_URL)) return null;
  return (
    `BETTER_AUTH_SECRET is still the example value "${COMPOSE_DEFAULT_SECRET}" while ` +
    `BETTER_AUTH_URL is ${env.BETTER_AUTH_URL ?? "not set"}. Set BETTER_AUTH_SECRET to a ` +
    "long random value (e.g. `openssl rand -base64 32`) before serving Clerq beyond localhost."
  );
}

// Logs the problem and stops the process. Node.js runtime only.
export function enforceStartupChecks(): void {
  const problem = insecureSecretProblem({
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  });
  if (problem) {
    console.error(`Clerq refused to start: ${problem}`);
    process.exit(1);
  }
}
