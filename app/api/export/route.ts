import { getDb } from "@/db";
import { exportBusinessData } from "@/modules/export/service";
import { resolveDownloadAccess } from "@/server/download-access";

// Download the caller's entire business as one portable JSON file - the
// user-facing "export everything" action. It mirrors the tenancy and
// permission gates of the tRPC dataExport.everything procedure, resolved here
// against the browser session so the settings page can link straight to it.
//
// The business is derived from the caller's active membership, never from the
// request, so the file can only ever contain the caller's own data.

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "business";
}

export async function GET(req: Request): Promise<Response> {
  // Session, suspensions (account and business) and data.export: the same
  // gates as dataExport.everything.
  const membership = await resolveDownloadAccess(req.headers, "data.export");
  if (membership instanceof Response) {
    return membership;
  }

  // Same rule as dataExport.everything: no copies of a user's data while a
  // platform admin is viewing as them.
  if (membership.impersonating) {
    return new Response("Data export is off while viewing as another user", {
      status: 403,
    });
  }

  const data = await exportBusinessData(getDb(), membership.businessId);

  const businessName = (data.data.business[0] as { name?: string } | undefined)
    ?.name;
  const datePart = data.exportedAt.slice(0, 10); // YYYY-MM-DD
  const filename = `clerq-export-${slugify(businessName ?? "business")}-${datePart}.json`;

  // Pretty-printed: an export is meant to be read and re-imported by a human or
  // a tool, not squeezed for bytes.
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
