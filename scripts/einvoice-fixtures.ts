// Writes the e-invoice export of every case in modules/einvoice/fixtures.ts
// to <out dir>/<case>.xml, for scripts/validate-einvoices.sh (CI job
// "einvoice"). Usage: pnpm exec tsx scripts/einvoice-fixtures.ts <out dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EINVOICE_FIXTURES } from "@/modules/einvoice/fixtures";
import { buildEinvoiceModel } from "@/modules/einvoice/model";
import { buildUblInvoice } from "@/modules/einvoice/ubl";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: tsx scripts/einvoice-fixtures.ts <out dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

for (const { name, source } of EINVOICE_FIXTURES) {
  const result = buildEinvoiceModel(source);
  if (!result.ok) {
    console.error(`${name}: not exportable: ${result.missing.join("; ")}`);
    process.exit(1);
  }
  writeFileSync(join(outDir, `${name}.xml`), buildUblInvoice(result.model));
  console.log(`wrote ${name}.xml`);
}
