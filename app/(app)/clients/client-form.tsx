"use client";

import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PeppolIdFields,
  peppolIdDraft,
  peppolIdFromDraft,
} from "@/components/peppol-id-fields";
import {
  PostalAddressFields,
  postalAddressDraft,
  postalAddressFromDraft,
} from "@/components/postal-address-fields";
import { RateFields, type RateUnit } from "@/components/rate-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  CountryOption,
  PostalAddress,
  PostalAddressInput,
} from "@/lib/postal-address";
import { majorToMinor, minorToMajor } from "@/modules/billing/currency";
import { useTRPC } from "@/server/trpc/client";

type Contact = { name: string; email?: string; role?: string };

export type ClientFormValues = {
  name: string;
  contacts: Contact[];
  notes?: string;
  address?: string | null;
  postalAddress?: PostalAddress | PostalAddressInput | null;
  companyNumber?: string | null;
  vatNumber?: string | null;
  buyerReference?: string | null;
  peppolId?: string | null;
  defaultRateMinor?: number | null;
  defaultRateCurrency?: string | null;
  defaultRateUnit?: RateUnit;
  budgetMinor?: number | null;
  budgetCurrency?: string | null;
};

export function ClientForm({
  clientId,
  initial,
  countryOptions,
  einvoicingEnabled = false,
}: {
  clientId?: string;
  initial?: ClientFormValues;
  countryOptions: CountryOption[];
  // Settings -> E-invoicing (#5065). While off, the structured address box
  // is hidden and left out of the save (= kept as it is).
  einvoicingEnabled?: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [contacts, setContacts] = useState<Contact[]>(initial?.contacts ?? []);
  const [rate, setRate] = useState(
    initial?.defaultRateMinor != null && initial.defaultRateCurrency
      ? minorToMajor(initial.defaultRateMinor, initial.defaultRateCurrency)
      : "",
  );
  const [rateCurrency, setRateCurrency] = useState(
    initial?.defaultRateCurrency ?? "",
  );
  const [rateUnit, setRateUnit] = useState<RateUnit>(
    initial?.defaultRateUnit ?? "hour",
  );
  const [budget, setBudget] = useState(
    initial?.budgetMinor != null && initial.budgetCurrency
      ? minorToMajor(initial.budgetMinor, initial.budgetCurrency)
      : "",
  );
  const [budgetCurrency, setBudgetCurrency] = useState(
    initial?.budgetCurrency ?? "",
  );
  const [rateError, setRateError] = useState<string | null>(null);
  const [vatNumber, setVatNumber] = useState(initial?.vatNumber ?? "");
  const [buyerReference, setBuyerReference] = useState(
    initial?.buyerReference ?? "",
  );
  const [companyNumber, setCompanyNumber] = useState(
    initial?.companyNumber ?? "",
  );
  const [peppol, setPeppol] = useState(() => peppolIdDraft(initial?.peppolId));
  const [peppolError, setPeppolError] = useState<string | null>(null);
  const [address, setAddress] = useState(initial?.address ?? "");
  const [postal, setPostal] = useState(() =>
    postalAddressDraft(initial?.postalAddress as PostalAddress | null),
  );
  const [postalError, setPostalError] = useState<string | null>(null);

  const create = useMutation(
    trpc.clients.create.mutationOptions({
      onSuccess: (created) => {
        router.push(`/clients/${created.id}`);
        router.refresh();
      },
    }),
  );
  const update = useMutation(
    trpc.clients.update.mutationOptions({
      onSuccess: () => {
        router.push(`/clients/${clientId}`);
        router.refresh();
      },
    }),
  );
  const mutation = clientId ? update : create;

  function setContact(index: number, patch: Partial<Contact>) {
    setContacts((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setRateError(null);
    setPostalError(null);
    const postalAddress = einvoicingEnabled
      ? postalAddressFromDraft(postal)
      : { value: undefined };
    if ("error" in postalAddress) {
      setPostalError(postalAddress.error);
      return;
    }
    let defaultRateMinor: number | null = null;
    let defaultRateCurrency: string | null = null;
    if (rate.trim()) {
      const code = rateCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        setRateError("Use a three-letter currency code like EUR");
        return;
      }
      defaultRateMinor = majorToMinor(rate, code);
      if (defaultRateMinor === null) {
        setRateError(`That rate has more decimal places than ${code} allows`);
        return;
      }
      defaultRateCurrency = code;
    }
    let budgetMinor: number | null = null;
    let budgetCurrencyCode: string | null = null;
    if (budget.trim()) {
      const code = budgetCurrency.trim().toUpperCase() || defaultRateCurrency || "";
      if (!/^[A-Z]{3}$/.test(code)) {
        setRateError("Pick a currency for the budget");
        return;
      }
      budgetMinor = majorToMinor(budget, code);
      if (budgetMinor === null) {
        setRateError(`That budget has more decimal places than ${code} allows`);
        return;
      }
      budgetCurrencyCode = code;
    }
    setPeppolError(null);
    const peppolId = peppolIdFromDraft(peppol);
    if (einvoicingEnabled && "error" in peppolId) {
      setPeppolError(peppolId.error);
      return;
    }
    const data: ClientFormValues = {
      name,
      notes: notes || undefined,
      address: address.trim() || null,
      postalAddress: postalAddress.value,
      companyNumber: companyNumber.trim() || null,
      vatNumber: vatNumber.trim() || null,
      // Left out while e-invoicing is off (= kept as it is).
      buyerReference: einvoicingEnabled
        ? buyerReference.trim() || null
        : undefined,
      peppolId:
        einvoicingEnabled && "value" in peppolId ? peppolId.value : undefined,
      defaultRateMinor,
      defaultRateCurrency,
      defaultRateUnit: rateUnit,
      budgetMinor,
      budgetCurrency: budgetCurrencyCode,
      contacts: contacts
        .filter((c) => c.name.trim().length > 0)
        .map((c) => ({
          name: c.name,
          email: c.email || undefined,
          role: c.role || undefined,
        })),
    };
    if (clientId) {
      update.mutate({ clientId, data });
    } else {
      create.mutate(data);
    }
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                placeholder="Brightwood s.r.o."
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2 sm:w-40">
              <Label htmlFor="companyNumber">Company number</Label>
              <Input
                id="companyNumber"
                placeholder="12345678"
                value={companyNumber}
                onChange={(e) => setCompanyNumber(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2 sm:w-40">
              <Label htmlFor="vatNumber">VAT number</Label>
              <Input
                id="vatNumber"
                placeholder="CZ12345678"
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="address">Address</Label>
            <textarea
              id="address"
              rows={3}
              placeholder={"12 Harbour Street\nBristol BS1 4QA"}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
            <p className="text-xs text-muted-foreground">
              Printed on invoices in the &ldquo;Billed to&rdquo; block.
            </p>
          </div>

          {einvoicingEnabled ? (
            <PostalAddressFields
              value={postal}
              onChange={setPostal}
              freeText={address}
              countryOptions={countryOptions}
              error={postalError}
            />
          ) : null}

          {einvoicingEnabled ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="buyerReference">
                Buyer reference / PO number (optional)
              </Label>
              <Input
                id="buyerReference"
                value={buyerReference}
                onChange={(e) => setBuyerReference(e.target.value)}
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">
                Copied onto each new invoice for this client, where you can
                change it. Some public bodies require one (Germany: the
                Leitweg-ID).
              </p>
            </div>
          ) : null}

          {einvoicingEnabled ? (
            <PeppolIdFields
              idPrefix="client"
              value={peppol}
              onChange={setPeppol}
              error={peppolError}
              hint="Where e-invoices for this client are addressed. Leave it empty and Clerq uses the client's VAT number (or, in Denmark, Iceland, Norway and Sweden, the company number)."
            />
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Contacts</Label>
            {contacts.map((contact, index) => (
              <div key={index} className="flex gap-2">
                <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label="Contact name"
                    placeholder="Name"
                    value={contact.name}
                    onChange={(e) => setContact(index, { name: e.target.value })}
                  />
                  <Input
                    aria-label="Contact email"
                    type="email"
                    placeholder="Email"
                    value={contact.email ?? ""}
                    onChange={(e) =>
                      setContact(index, { email: e.target.value })
                    }
                  />
                  <Input
                    aria-label="Contact role"
                    placeholder="Role"
                    value={contact.role ?? ""}
                    onChange={(e) => setContact(index, { role: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove contact"
                  className="shrink-0"
                  onClick={() =>
                    setContacts((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setContacts((prev) => [...prev, { name: "" }])}
              >
                Add contact
              </Button>
            </div>
          </div>

          <RateFields
            rate={rate}
            currency={rateCurrency}
            unit={rateUnit}
            onRateChange={setRate}
            onCurrencyChange={setRateCurrency}
            onUnitChange={setRateUnit}
          />
          <p className="-mt-2 text-xs text-muted-foreground">
            Used when you work this client solo. Add per-member rates from the
            client page after saving.
          </p>

          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="budget">Overall budget (optional)</Label>
              <Input
                id="budget"
                inputMode="decimal"
                placeholder="20000"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
            <div className="flex w-28 flex-col gap-2">
              <Label htmlFor="budgetCurrency">Currency</Label>
              <Input
                id="budgetCurrency"
                maxLength={3}
                placeholder="EUR"
                className="uppercase"
                value={budgetCurrency}
                onChange={(e) => setBudgetCurrency(e.target.value)}
              />
            </div>
          </div>
          {rateError ? (
            <p role="alert" className="text-sm text-destructive">
              {rateError}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              rows={4}
              placeholder="Anything worth remembering"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
          </div>

          {mutation.error ? (
            <p role="alert" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={mutation.isPending}>
              {clientId
                ? mutation.isPending
                  ? "Saving..."
                  : "Save changes"
                : mutation.isPending
                  ? "Adding..."
                  : "Add client"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
