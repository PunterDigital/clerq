"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CurrencySelect } from "@/components/currency-select";
import {
  PostalAddressFields,
  postalAddressDraft,
  postalAddressFromDraft,
} from "@/components/postal-address-fields";
import type { CurrencyOption } from "@/lib/currencies";
import { formatIban, isValidBic, isValidIban } from "@/lib/einvoice-codes";
import type { CountryOption, PostalAddress } from "@/lib/postal-address";
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
import { useTRPC } from "@/server/trpc/client";

export function SettingsForm({
  initial,
  currencyOptions,
  countryOptions,
  currentYear,
}: {
  initial: {
    name: string;
    address: string | null;
    postalAddress: PostalAddress | null;
    einvoicingEnabled: boolean;
    iban: string | null;
    bic: string | null;
    currency: string;
    hoursPerDay: number;
    standardRatePct: string | null;
    vatNumber: string | null;
  };
  currencyOptions: CurrencyOption[];
  countryOptions: CountryOption[];
  currentYear: number;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.address ?? "");
  const [postal, setPostal] = useState(() =>
    postalAddressDraft(initial.postalAddress),
  );
  const [postalError, setPostalError] = useState<string | null>(null);
  const [einvoicing, setEinvoicing] = useState(initial.einvoicingEnabled);
  const [iban, setIban] = useState(initial.iban ? formatIban(initial.iban) : "");
  const [bic, setBic] = useState(initial.bic ?? "");
  const [bankError, setBankError] = useState<string | null>(null);
  const [currency, setCurrency] = useState(initial.currency);
  const [hoursPerDay, setHoursPerDay] = useState(String(initial.hoursPerDay));
  const [standardRatePct, setStandardRatePct] = useState(
    initial.standardRatePct ?? "",
  );
  const [vatNumber, setVatNumber] = useState(initial.vatNumber ?? "");
  const [nextNumber, setNextNumber] = useState("");

  const update = useMutation(
    trpc.business.updateSettings.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );
  const updateEinvoicing = useMutation(
    trpc.business.updateEinvoicing.mutationOptions({
      onSuccess: () => router.refresh(),
    }),
  );
  const configureNumber = useMutation(
    trpc.invoices.configureNextNumber.mutationOptions({
      onSuccess: () => {
        setNextNumber("");
        router.refresh();
      },
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Business</CardTitle>
          <CardDescription>
            The entity you invoice from
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parsedHours = Number(hoursPerDay);
              // The structured address is saved from the E-invoicing card,
              // so it is left out here (= kept).
              update.mutate({
                name,
                address: address.trim() || null,
                currency,
                hoursPerDay:
                  Number.isInteger(parsedHours) && parsedHours >= 1
                    ? parsedHours
                    : 8,
                standardRatePct: standardRatePct.trim() || null,
                vatNumber: vatNumber.trim() || null,
              });
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="address">Address</Label>
              <textarea
                id="address"
                rows={3}
                placeholder={"12 Harbour Street\nBristol BS1 4QA\nUnited Kingdom"}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
              <p className="text-sm text-muted-foreground">
                Printed on your invoices, exactly as written here
              </p>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex flex-col gap-2 sm:w-64">
                <Label htmlFor="currency">Base currency</Label>
                <CurrencySelect
                  id="currency"
                  required
                  value={currency}
                  onChange={setCurrency}
                  options={currencyOptions}
                />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="vat">Standard VAT rate (%)</Label>
                <Input
                  id="vat"
                  inputMode="decimal"
                  placeholder="21"
                  value={standardRatePct}
                  onChange={(e) => setStandardRatePct(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Used for standard-rate invoices - your jurisdiction&apos;s
                  rate, never guessed for you
                </p>
              </div>
            </div>
            <div className="flex w-44 flex-col gap-2">
              <Label htmlFor="hoursPerDay">Hours per day</Label>
              <Input
                id="hoursPerDay"
                type="number"
                min="1"
                max="24"
                step="1"
                value={hoursPerDay}
                onChange={(e) => setHoursPerDay(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Turns a day rate into an hourly rate (a {hoursPerDay || "8"}-hour
                day)
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="businessVat">VAT number</Label>
              <Input
                id="businessVat"
                placeholder="GB123456789"
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Printed on invoices - required before issuing reverse-charge
                invoices
              </p>
            </div>
            {update.error ? (
              <p role="alert" className="text-sm text-destructive">
                {update.error.message}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>E-invoicing</CardTitle>
          <CardDescription>
            Optional, for businesses established in the EEA (EU, Iceland,
            Liechtenstein, Norway). Adds the structured address and other
            fields electronic invoices (EN 16931) need. Invoice PDFs also
            show your bank details and the client&apos;s PO number once you
            add them
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPostalError(null);
              setBankError(null);
              if (!einvoicing) {
                updateEinvoicing.mutate({ enabled: false });
                return;
              }
              const postalAddress = postalAddressFromDraft(postal);
              if ("error" in postalAddress) {
                setPostalError(postalAddress.error);
                return;
              }
              if (!postalAddress.value) {
                setPostalError(
                  "Fill in the business address below to turn on e-invoicing",
                );
                return;
              }
              if (iban.trim() && !isValidIban(iban)) {
                setBankError("That IBAN doesn't look right - check the number");
                return;
              }
              if (bic.trim() && !isValidBic(bic)) {
                setBankError(
                  "A BIC is 8 or 11 letters and digits, like DEUTDEFF",
                );
                return;
              }
              updateEinvoicing.mutate({
                enabled: true,
                postalAddress: postalAddress.value,
                iban: iban.trim() || null,
                bic: bic.trim() || null,
              });
            }}
            className="flex flex-col gap-4"
          >
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={einvoicing}
                onChange={(e) => setEinvoicing(e.target.checked)}
                className="size-4"
              />
              Enable e-invoicing
            </label>
            {einvoicing ? (
              <PostalAddressFields
                value={postal}
                onChange={setPostal}
                freeText={address}
                countryOptions={countryOptions}
                error={postalError}
              />
            ) : null}
            {einvoicing ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  Bank details (optional)
                </p>
                <p className="text-sm text-muted-foreground">
                  Printed under payment details on your invoices, and sent as
                  the credit-transfer account in e-invoices.
                </p>
                <div className="flex flex-wrap gap-4">
                  <div className="flex flex-1 flex-col gap-2">
                    <Label htmlFor="iban">IBAN</Label>
                    <Input
                      id="iban"
                      value={iban}
                      onChange={(e) => setIban(e.target.value)}
                      placeholder="DE89 3704 0044 0532 0130 00"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:w-48">
                    <Label htmlFor="bic">BIC</Label>
                    <Input
                      id="bic"
                      value={bic}
                      onChange={(e) => setBic(e.target.value)}
                      placeholder="COBADEFFXXX"
                      autoComplete="off"
                    />
                  </div>
                </div>
                {bankError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {bankError}
                  </p>
                ) : null}
              </div>
            ) : null}
            {updateEinvoicing.error ? (
              <p role="alert" className="text-sm text-destructive">
                {updateEinvoicing.error.message}
              </p>
            ) : null}
            {updateEinvoicing.isSuccess && !updateEinvoicing.isPending ? (
              <p className="text-sm text-muted-foreground">
                {updateEinvoicing.data?.einvoicingEnabled
                  ? "E-invoicing is on"
                  : "E-invoicing is off"}
              </p>
            ) : null}
            <div>
              <Button
                type="submit"
                variant="outline"
                disabled={updateEinvoicing.isPending}
              >
                {updateEinvoicing.isPending ? "Saving..." : "Save e-invoicing"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice numbering</CardTitle>
          <CardDescription>
            Numbers run {currentYear}-0001, {currentYear}-0002, ... per year.
            Moving from another tool mid-year? Set where {currentYear}{" "}
            continues - it can only move forward, never over an issued number
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = Number(nextNumber);
              if (Number.isInteger(parsed)) {
                configureNumber.mutate({ year: currentYear, nextNumber: parsed });
              }
            }}
            className="flex items-end gap-2"
          >
            <div className="flex w-44 flex-col gap-2">
              <Label htmlFor="nextNumber">Next number for {currentYear}</Label>
              <Input
                id="nextNumber"
                type="number"
                min="1"
                max="9999"
                step="1"
                required
                placeholder="100"
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={configureNumber.isPending || !nextNumber}
            >
              {configureNumber.isPending ? "Saving..." : "Set"}
            </Button>
          </form>
          {configureNumber.error ? (
            <p role="alert" className="pt-2 text-sm text-destructive">
              {configureNumber.error.message}
            </p>
          ) : null}
          {configureNumber.isSuccess ? (
            <p className="pt-2 text-sm text-muted-foreground">
              Numbering updated
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
