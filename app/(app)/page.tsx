import { Clock, FolderKanban, ReceiptText, Timer } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";

import { InvoiceStatusPill } from "@/components/status-pill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatMinutes, formatMoney } from "@/lib/format";
import { getEffectiveSession } from "@/server/session";
import { caller } from "@/server/trpc/server";

// Per-request: session check + DB lookups, never prerenderable.
export const dynamic = "force-dynamic";

const activityLabels: Record<string, string> = {
  note: "Note added",
  client_created: "Client created",
  client_updated: "Client updated",
  client_archived: "Client archived",
  client_unarchived: "Client restored",
  project_created: "Project created",
  invoice_voided: "Invoice voided",
  credit_note_issued: "Credit note issued",
};

function greeting(hour: number): string {
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-[var(--primary-subtle-fg)]">{icon}</span>
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-xl font-semibold tabular">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const session = await getEffectiveSession(await headers());
  const summary = await caller.dashboard.summary();
  const firstName = session?.user.name.split(" ")[0] ?? "there";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl">
        {greeting(new Date().getHours())}, {firstName}
      </h1>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<ReceiptText className="size-4" aria-hidden />}
          label="Outstanding"
          value={
            summary.outstanding.totals.length === 0 ? (
              "Nothing"
            ) : (
              <span className="flex flex-col">
                {summary.outstanding.totals.map((t) => (
                  <span key={t.currency}>
                    {formatMoney(t.totalMinor, t.currency)}
                  </span>
                ))}
              </span>
            )
          }
          sub={
            summary.outstanding.count === 0
              ? "No unpaid invoices"
              : `${summary.outstanding.count} ${
                  summary.outstanding.count === 1 ? "invoice" : "invoices"
                }${
                  summary.outstanding.overdueCount > 0
                    ? ` - ${summary.outstanding.overdueCount} overdue`
                    : ""
                }`
          }
        />
        <StatCard
          icon={<Clock className="size-4" aria-hidden />}
          label="Hours this week"
          value={
            summary.week.seconds > 0
              ? formatMinutes(Math.round(summary.week.seconds / 60))
              : "0h"
          }
          sub={
            summary.week.projects > 0
              ? `Across ${summary.week.projects} ${
                  summary.week.projects === 1 ? "project" : "projects"
                }`
              : "Nothing tracked yet"
          }
        />
        <StatCard
          icon={<FolderKanban className="size-4" aria-hidden />}
          label="Active projects"
          value={summary.projects.active}
          sub={`${summary.projects.openTasks} open ${
            summary.projects.openTasks === 1 ? "task" : "tasks"
          }`}
        />
        <StatCard
          icon={<Timer className="size-4" aria-hidden />}
          label="Unbilled time"
          value={
            summary.unbilledSeconds > 0
              ? formatMinutes(Math.round(summary.unbilledSeconds / 60))
              : "0h"
          }
          sub={
            summary.unbilledSeconds > 0
              ? "Ready to invoice"
              : "All caught up"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="gap-0 py-0">
          <CardHeader className="py-4">
            <CardTitle>Recent invoices</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {summary.recentInvoices.length === 0 ? (
              <p className="px-6 pb-5 text-sm text-muted-foreground">
                No invoices yet - track some time, then turn it into your
                first invoice
              </p>
            ) : (
              <div className="border-t">
                {summary.recentInvoices.map((invoice) => (
                  <Link
                    key={invoice.id}
                    href={`/invoices/${invoice.id}`}
                    className="flex items-center gap-3 border-b px-6 py-3 transition-colors last:rounded-b-lg last:border-b-0 hover:bg-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium tabular">
                        {invoice.number ?? "Draft"}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {invoice.clientName}
                      </div>
                    </div>
                    <span className="text-sm font-medium tabular">
                      {formatMoney(invoice.totalMinor, invoice.currency)}
                    </span>
                    <InvoiceStatusPill status={invoice.status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing here yet</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {summary.recentActivity.map((item) => (
                  <li key={item.id} className="flex flex-col">
                    <span className="text-sm">
                      <Link
                        href={`/clients/${item.clientId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {item.clientName}
                      </Link>{" "}
                      <span className="text-muted-foreground">
                        - {activityLabels[item.type] ?? item.type}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(item.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
