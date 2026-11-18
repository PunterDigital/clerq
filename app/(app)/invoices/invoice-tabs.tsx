"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// Sub-navigation for the invoices area: one-off invoices vs recurring
// (retainers). Sub-routes rather than a query param, so each tab deep-links,
// carries its own metadata, and highlights via the pathname. The sidebar's
// "Invoices" item already matches this whole subtree.
const tabs = [
  { href: "/invoices", label: "Invoices" },
  { href: "/invoices/recurring", label: "Recurring" },
  { href: "/invoices/credit-notes", label: "Credit notes" },
] as const;

export function InvoiceTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b">
      {tabs.map((tab) => {
        // The one-off tab must not light up on the recurring subtree, so it
        // matches exactly; the recurring tab matches its subtree.
        const active =
          tab.href === "/invoices"
            ? pathname === "/invoices"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
