import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getRequestMembership, getRequestSession } from "@/server/request-scope";

export const metadata: Metadata = {
  title: "Data - Clerq",
};

export const dynamic = "force-dynamic";

export default async function DataSettingsPage() {
  // Exporting the whole business is a high-trust action (owner/admin only),
  // so the card is shown only to callers who actually hold the permission.
  const session = await getRequestSession();
  const membership = session
    ? await getRequestMembership(session.user.id)
    : null;
  const canExport = membership?.permissions.has("data.export") ?? false;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Import data</CardTitle>
          <CardDescription>
            Bring clients over from another tool&apos;s CSV export
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href="/settings/import">Import clients from CSV</Link>
          </Button>
        </CardContent>
      </Card>
      {canExport ? (
        <Card>
          <CardHeader>
            <CardTitle>Export your data</CardTitle>
            <CardDescription>
              Download everything in this business - clients, projects, tasks,
              time, invoices, expenses, team and settings - as one portable
              JSON file. Your data is yours to take with you, any time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <a href="/api/export" download>
                Export all data
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
