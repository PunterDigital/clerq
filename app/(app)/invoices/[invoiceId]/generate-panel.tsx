"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTRPC, useTRPCClient } from "@/server/trpc/client";

const selectClassName =
  "h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

type Grouping = "person_rate" | "task" | "single";
type RateDraft = { rate: string; source: "ecb" | "manual"; effectiveDate?: string };

type NothingToBillDetails = {
  unpriced: number;
  running: number;
  nonBillable: number;
  alreadyBilled: {
    invoiceId: string;
    number: string | null;
    status: string;
    entries: number;
  }[];
};

// "Nothing to bill" is never left unexplained: the details say where the
// client's time actually is, so the user knows what to do next instead of
// staring at an empty invoice.
function nothingToBillNotice(details?: NothingToBillDetails): string {
  if (!details) {
    return "No unbilled billable time for this client";
  }
  const parts: string[] = [];
  for (const held of details.alreadyBilled) {
    const label = held.number
      ? `invoice ${held.number} (${held.status})`
      : "a draft invoice";
    parts.push(
      `${held.entries} ${held.entries === 1 ? "entry is" : "entries are"} already billed on ${label}`,
    );
  }
  if (details.unpriced > 0) {
    parts.push(
      `${details.unpriced} ${details.unpriced === 1 ? "entry has" : "entries have"} no rate (rates apply to entries logged after they are set)`,
    );
  }
  if (details.running > 0) {
    parts.push(
      `${details.running} ${details.running === 1 ? "timer is" : "timers are"} still running`,
    );
  }
  if (details.nonBillable > 0) {
    parts.push(
      `${details.nonBillable} ${details.nonBillable === 1 ? "entry is" : "entries are"} non-billable`,
    );
  }
  if (parts.length === 0) {
    return "No time has been tracked for this client yet";
  }
  return `No unbilled time to pull: ${parts.join("; ")}`;
}

// Pulls unbilled time onto the draft. When entries carry rates in other
// currencies, the panel fetches the ECB rate per currency for review (or
// manual entry when uncovered/edited) - the user confirms exactly what
// gets stored on the lines.
export function GeneratePanel({
  invoiceId,
  invoiceCurrency,
  projects,
}: {
  invoiceId: string;
  invoiceCurrency: string;
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const [grouping, setGrouping] = useState<Grouping>("person_rate");
  const [projectId, setProjectId] = useState<string>("");
  const [includeTaskList, setIncludeTaskList] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [replace, setReplace] = useState(false);
  const [rates, setRates] = useState<Record<string, RateDraft> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useMutation(
    trpc.invoices.generateFromTime.mutationOptions({
      onSuccess: async (result, variables) => {
        setError(null);
        if (result.ok) {
          setRates(null);
          // Always say what happened: a Replace that rebuilds identical
          // lines otherwise looks like it did nothing.
          const lines = `${result.lineCount} ${result.lineCount === 1 ? "line" : "lines"}`;
          const done = variables.replace
            ? `Replaced the generated lines - ${lines} now`
            : `Added ${lines}`;
          setNotice(
            result.unpricedEntryIds.length > 0
              ? `${done}. ${result.unpricedEntryIds.length} billable ${
                  result.unpricedEntryIds.length === 1 ? "entry has" : "entries have"
                } no rate and stayed unbilled - set a default rate and regenerate`
              : done,
          );
          router.refresh();
          return;
        }
        if (result.reason === "missing_fx_rates") {
          // Fetch today's ECB rate for each currency for the user to
          // review; uncovered pairs start empty as manual entries.
          const drafts: Record<string, RateDraft> = {};
          for (const currency of result.currencies) {
            const ecb = await trpcClient.invoices.fetchRate.query({
              from: currency,
              to: invoiceCurrency,
            });
            drafts[currency] = ecb
              ? { rate: ecb.rate, source: "ecb", effectiveDate: ecb.effectiveDate }
              : { rate: "", source: "manual" };
          }
          setRates(drafts);
          setNotice(null);
          return;
        }
        if (result.reason === "mixed_rates_for_single_line") {
          setError(
            "These entries have different rates - single line only works with one rate",
          );
          return;
        }
        if (result.reason === "nothing_to_bill") {
          setNotice(nothingToBillNotice(result.details));
          return;
        }
        setError("Only draft invoices can be generated onto");
      },
      onError: (mutationError) => setError(mutationError.message),
    }),
  );

  function run(withRates: boolean) {
    setError(null);
    setNotice(null);
    generate.mutate({
      invoiceId,
      grouping,
      projectId: projectId || undefined,
      includeTaskList,
      includeNotes,
      replace,
      fxRates:
        withRates && rates
          ? Object.fromEntries(
              Object.entries(rates).map(([currency, draft]) => [
                currency,
                { rate: draft.rate.trim(), source: draft.source },
              ]),
            )
          : undefined,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unbilled time</CardTitle>
        <CardDescription>
          Pull this client&apos;s unbilled tracked time onto the invoice
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-1 basis-40 flex-col gap-2">
            <Label htmlFor="grouping">Group as</Label>
            <select
              id="grouping"
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as Grouping)}
              className={selectClassName}
            >
              <option value="person_rate">One line per person and rate</option>
              <option value="task">One line per task</option>
              <option value="single">A single line</option>
            </select>
          </div>
          <div className="flex flex-1 basis-40 flex-col gap-2">
            <Label htmlFor="project">Project</Label>
            <select
              id="project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={selectClassName}
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {grouping !== "task" ? (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeTaskList}
              onChange={(e) => setIncludeTaskList(e.target.checked)}
            />
            List covered tasks in the description
          </label>
        ) : null}
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeNotes}
            onChange={(e) => setIncludeNotes(e.target.checked)}
          />
          List timesheet notes under each line
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Replace lines generated earlier on this draft (their time is pulled
          again with the grouping chosen above; manual lines are kept)
        </label>

        {rates ? (
          <div className="flex flex-col gap-3 rounded-md border bg-[var(--surface-sunken)] p-3">
            <p className="text-sm">
              Some rates are in other currencies - confirm the conversion to{" "}
              {invoiceCurrency}
            </p>
            {Object.entries(rates).map(([currency, draft]) => (
              <div key={currency} className="flex items-center gap-2">
                <span className="w-20 text-sm font-medium tabular">
                  1 {currency} =
                </span>
                <Input
                  aria-label={`Rate from ${currency} to ${invoiceCurrency}`}
                  inputMode="decimal"
                  value={draft.rate}
                  onChange={(e) =>
                    setRates((prev) => ({
                      ...(prev ?? {}),
                      [currency]: { rate: e.target.value, source: "manual" },
                    }))
                  }
                  className="h-8 max-w-36 tabular"
                />
                <span className="text-sm text-muted-foreground">
                  {invoiceCurrency}
                  {draft.source === "ecb" && draft.effectiveDate
                    ? ` - ECB, ${draft.effectiveDate}`
                    : " - manual"}
                </span>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                disabled={
                  generate.isPending ||
                  Object.values(rates).some((d) => !/^\d+(\.\d+)?$/.test(d.rate.trim()))
                }
                onClick={() => run(true)}
              >
                {generate.isPending ? "Generating..." : "Convert and add lines"}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button disabled={generate.isPending} onClick={() => run(false)}>
              {generate.isPending ? "Generating..." : "Generate lines"}
            </Button>
          </div>
        )}

        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
