// Next.js calls register() once when the server process boots - its only
// built-in startup hook. We use it to refuse an insecure configuration
// (lib/startup-checks.ts) and to start the in-process recurring-invoice
// scheduler (see jobs/recurring-scheduler.ts). Guarded to the Node.js runtime
// so it never runs on the edge, where there is no long-lived process to tick
// and the database driver isn't available.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { enforceStartupChecks } = await import("@/lib/startup-checks");
  enforceStartupChecks();
  const { startRecurringScheduler } = await import("@/jobs/recurring-scheduler");
  startRecurringScheduler();
}
