"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parsePeppolId } from "@/lib/einvoice-codes-shared";
import { EAS_SCHEMES } from "@/lib/peppol-eas";

// A Peppol ID as the form holds it: the scheme picked from the Peppol list
// and the number typed next to it (#5075). Stored as "scheme:value".
export type PeppolIdDraft = { scheme: string; value: string };

export function peppolIdDraft(stored: string | null | undefined): PeppolIdDraft {
  const parsed = parsePeppolId(stored);
  return parsed
    ? { scheme: parsed.scheme, value: parsed.id }
    : { scheme: "", value: "" };
}

// The draft as the value to save: null when both parts are empty, an error
// when only one is filled in or the number isn't an identifier.
export function peppolIdFromDraft(
  draft: PeppolIdDraft,
): { value: string | null } | { error: string } {
  const value = draft.value.trim();
  if (!draft.scheme && !value) {
    return { value: null };
  }
  if (!draft.scheme || !value) {
    return {
      error: "A Peppol ID needs both a scheme and a number - or leave both empty",
    };
  }
  const joined = `${draft.scheme}:${value}`;
  if (!parsePeppolId(joined)) {
    return {
      error:
        "That Peppol ID number doesn't look right: letters and digits only, no spaces",
    };
  }
  return { value: joined };
}

const selectClass =
  "h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

// Long register names are cut so the closed select stays readable.
export function schemeLabel(scheme: { code: string; name: string }): string {
  const name = scheme.name.length > 70 ? `${scheme.name.slice(0, 67)}...` : scheme.name;
  return `${scheme.code} - ${name}`;
}

export function PeppolIdFields({
  idPrefix,
  value,
  onChange,
  error,
  hint,
}: {
  idPrefix: string;
  value: PeppolIdDraft;
  onChange: (next: PeppolIdDraft) => void;
  error?: string | null;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Peppol ID (optional)</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor={`${idPrefix}-peppol-scheme`}>Peppol ID scheme</Label>
          <select
            id={`${idPrefix}-peppol-scheme`}
            value={value.scheme}
            onChange={(e) => onChange({ ...value, scheme: e.target.value })}
            className={selectClass}
          >
            <option value="">None</option>
            {EAS_SCHEMES.map((s) => (
              <option key={s.code} value={s.code}>
                {schemeLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2 sm:w-56">
          <Label htmlFor={`${idPrefix}-peppol-value`}>Peppol ID number</Label>
          <Input
            id={`${idPrefix}-peppol-value`}
            value={value.value}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            placeholder="12345678"
            maxLength={50}
            autoComplete="off"
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
