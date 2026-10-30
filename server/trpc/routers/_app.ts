import { createTRPCRouter } from "../init";
import { adminRouter } from "./admin";
import { apiKeysRouter } from "./api-keys";
import { businessRouter } from "./business";
import { clientsRouter } from "./clients";
import { dashboardRouter } from "./dashboard";
import { expensesRouter } from "./expenses";
import { exportRouter } from "./export";
import { healthRouter } from "./health";
import { invoicesRouter } from "./invoices";
import { projectsRouter } from "./projects";
import { recurringRouter } from "./recurring";
import { reportsRouter } from "./reports";
import { systemRouter } from "./system";
import { tasksRouter } from "./tasks";
import { teamRouter } from "./team";
import { timeRouter } from "./time";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  business: businessRouter,
  clients: clientsRouter,
  projects: projectsRouter,
  tasks: tasksRouter,
  time: timeRouter,
  invoices: invoicesRouter,
  recurring: recurringRouter,
  expenses: expensesRouter,
  team: teamRouter,
  dashboard: dashboardRouter,
  reports: reportsRouter,
  system: systemRouter,
  admin: adminRouter,
  dataExport: exportRouter,
  apiKeys: apiKeysRouter,
});

export type AppRouter = typeof appRouter;
