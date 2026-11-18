import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatMoney } from "@/lib/format";
import { caller } from "@/server/trpc/server";

import { ArchiveButton } from "./archive-button";
import { MemberRates } from "./member-rates";
import { NoteComposer } from "./note-composer";

export const metadata: Metadata = {
  title: "Client - Clerq",
};

export const dynamic = "force-dynamic";

type Contact = { name: string; email?: string; role?: string };

const activityLabels: Record<string, string> = {
  note: "Note",
  client_created: "Client created",
  client_updated: "Details updated",
  client_archived: "Archived",
  client_unarchived: "Restored from archive",
  project_created: "Project created",
  invoice_voided: "Invoice voided",
  credit_note_issued: "Credit note issued",
};

async function load(clientId: string) {
  try {
    const [client, activity, projects, budget] = await Promise.all([
      caller.clients.get({ clientId }),
      caller.clients.activity({ clientId }),
      caller.projects.list({ clientId }),
      caller.reports.clientBudget({ clientId }),
    ]);
    return { client, activity, projects, budget };
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const { client, activity, projects, budget } = await load(clientId);
  const contacts = client.contacts as Contact[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-2xl">{client.name}</h1>
            {client.archivedAt ? (
              <span className="rounded-full bg-[var(--status-draft-bg)] px-2 py-px text-xs font-semibold text-[var(--status-draft-fg)]">
                Archived
              </span>
            ) : null}
          </div>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/clients/${client.id}/edit`}>Edit</Link>
        </Button>
        <ArchiveButton
          clientId={client.id}
          archived={Boolean(client.archivedAt)}
        />
      </div>

      {client.archivedAt ? (
        <div className="rounded-md border border-[var(--warning-subtle-fg)]/25 bg-[var(--warning-subtle)] px-4 py-3 text-sm text-[var(--warning-subtle-fg)]">
          This client is archived - they no longer appear in the clients
          list and cannot be picked for new projects or invoices. Restore
          them to work together again.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <NoteComposer clientId={client.id} />
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing here yet
                </p>
              ) : (
                <ul className="flex flex-col">
                  {activity.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col gap-0.5 border-b py-3 last:border-b-0"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium">
                          {activityLabels[item.type] ?? item.type}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(item.at)}
                        </span>
                      </div>
                      {item.type === "note" ? (
                        <p className="whitespace-pre-wrap text-sm text-foreground">
                          {(item.payload as { text: string }).text}
                        </p>
                      ) : null}
                      {item.type === "credit_note_issued" ? (
                        <CreditNoteActivity
                          payload={item.payload as CreditNotePayload}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Projects</CardTitle>
            </CardHeader>
            <CardContent>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No projects yet
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {projects.map((project) => (
                    <li key={project.id} className="flex items-center gap-2">
                      <Link
                        href={`/projects/${project.id}`}
                        className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {project.name}
                      </Link>
                      <StatusPill status={project.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {budget ? (
            <Card>
              <CardHeader>
                <CardTitle>Budget</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">
                    {formatMoney(budget.spentMinor, budget.currency)} of{" "}
                    {formatMoney(budget.budgetMinor, budget.currency)}
                  </span>
                  <span
                    className={
                      budget.state === "over"
                        ? "font-semibold text-destructive"
                        : budget.state === "near"
                          ? "font-semibold text-[var(--warning-subtle-fg)]"
                          : "text-muted-foreground"
                    }
                  >
                    {Math.round(budget.pct * 100)}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={
                      budget.state === "over"
                        ? "h-full bg-destructive"
                        : budget.state === "near"
                          ? "h-full bg-[var(--warning-subtle-fg)]"
                          : "h-full bg-primary"
                    }
                    style={{ width: `${Math.min(100, Math.round(budget.pct * 100))}%` }}
                  />
                </div>
                {budget.currencyMismatch.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Excludes work tracked in{" "}
                    {budget.currencyMismatch.join(", ")} (not converted).
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <MemberRates clientId={client.id} />

          {client.address || client.companyNumber || client.vatNumber ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {client.address ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {client.address}
                  </p>
                ) : null}
                {client.companyNumber ? (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Company no.</span>
                    <span className="tabular">{client.companyNumber}</span>
                  </div>
                ) : null}
                {client.vatNumber ? (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">VAT</span>
                    <span className="tabular">{client.vatNumber}</span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
            </CardHeader>
            <CardContent>
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contacts yet
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {contacts.map((contact, index) => (
                    <li key={index} className="flex flex-col">
                      <span className="text-sm font-medium">
                        {contact.name}
                        {contact.role ? (
                          <span className="text-muted-foreground">
                            {" "}
                            - {contact.role}
                          </span>
                        ) : null}
                      </span>
                      {contact.email ? (
                        <a
                          href={`mailto:${contact.email}`}
                          className="text-sm text-primary underline-offset-4 hover:underline"
                        >
                          {contact.email}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {client.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{client.notes}</p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type CreditNotePayload = {
  number: string;
  invoiceNumber: string | null;
  totalMinor: number;
  currency: string;
  reason: string | null;
};

// "CN-2026-0001 credits 2026-0012: -EUR 120.00 (wrong rate)" (#5042).
function CreditNoteActivity({ payload }: { payload: CreditNotePayload }) {
  return (
    <p className="text-sm text-muted-foreground tabular">
      {payload.number} credits {payload.invoiceNumber}: -
      {formatMoney(payload.totalMinor, payload.currency)}
      {payload.reason ? ` (${payload.reason})` : ""}
    </p>
  );
}
