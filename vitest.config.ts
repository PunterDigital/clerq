import { defineConfig } from "vitest/config";

// Two suites, run separately by the gate (see CONTRIBUTING):
// - unit: everything except the billing module
// - billing: the money-math fixture suite, kept separate because it is the
//   correctness core of the product and must stay independently runnable
export default defineConfig({
  // Resolve the "@/*" tsconfig path alias natively - Vite superseded the
  // vite-tsconfig-paths plugin with this built-in option.
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "{app,server,db,design,jobs,lib}/**/*.test.{ts,tsx}",
            "modules/{authz,clients,projects,time,proposals,expenses,team,reports,platform,export,einvoice}/**/*.test.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "billing",
          include: [
            "modules/billing/**/*.test.{ts,tsx}",
            "fixtures/billing/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
