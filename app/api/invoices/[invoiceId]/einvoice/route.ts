import { getDb } from "@/db";
import { exportEinvoice } from "@/modules/einvoice/service";
import { getActiveMembership } from "@/server/membership";
import { getEffectiveSession } from "@/server/session";

// GET /api/invoices/:invoiceId/einvoice - the "Download e-invoice (XML)"
// button: the invoice as Peppol BIS 3.0 UBL, for the signed-in user's
// business. 422 with the list of what's missing when it can't be built.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const session = await getEffectiveSession(req.headers);
  if (!session) {
    return new Response("Sign in first", { status: 401 });
  }
  const membership = await getActiveMembership(session.user.id);
  if (!membership) {
    return new Response("No business", { status: 403 });
  }
  const result = await exportEinvoice(getDb(), membership.businessId, invoiceId);
  if (!result) {
    return new Response("Not found", { status: 404 });
  }
  if (!result.ok) {
    return new Response(
      `This invoice can't be exported yet:\n- ${result.missing.join("\n- ")}\n`,
      { status: 422, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(result.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
