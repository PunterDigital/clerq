import type { Metadata } from "next";

import { listCountryOptions } from "@/lib/countries";
import { listCurrencyOptions } from "@/lib/currencies";
import { caller } from "@/server/trpc/server";

import { SettingsForm } from "./settings-form";

export const metadata: Metadata = {
  title: "Settings - Clerq",
};

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await caller.business.settings();
  const currentYear = new Date().getUTCFullYear();

  return (
    <SettingsForm
      initial={settings}
      currencyOptions={listCurrencyOptions()}
      countryOptions={listCountryOptions()}
      currentYear={currentYear}
    />
  );
}
