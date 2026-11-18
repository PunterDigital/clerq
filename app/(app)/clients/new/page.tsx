import type { Metadata } from "next";

import { listCountryOptions } from "@/lib/countries";

import { ClientForm } from "../client-form";

export const metadata: Metadata = {
  title: "New client - Clerq",
};

export default function NewClientPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <h1 className="text-2xl">New client</h1>
      <ClientForm countryOptions={listCountryOptions()} />
    </div>
  );
}
