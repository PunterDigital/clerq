#!/usr/bin/env bash
# Validates every *.xml in a folder against the CEN EN 16931 UBL rules and
# the Peppol BIS Billing 3.0 rules (card #5040, recipe from the spike in
# docs/spikes/eu-einvoicing.md). Fails on any fatal assertion; warnings are
# printed. Needs Java 11+, curl and the JDK's `jar` tool.
#
#   scripts/validate-einvoices.sh <xml folder> [tools folder]
#
# The validators run as CI tools only; nothing here ships in Clerq:
#   - CEN EN 16931 validation artefacts 1.3.17 (EUPL-1.2), precompiled XSLT
#   - Peppol BIS 3.0.22 Schematron (Apache-2.0 / MPL), compiled with
#   - SchXslt 1.10.1 (MIT), run by
#   - Saxon-HE 10.9 (MPL-2.0)
set -euo pipefail

xml_dir=${1:?usage: validate-einvoices.sh <xml folder> [tools folder]}
tools=${2:-${RUNNER_TEMP:-/tmp}/einvoice-tools}
mkdir -p "$tools"

fetch() { # url file sha256
  local url=$1 file=$tools/$2 sum=$3
  if [ ! -f "$file" ]; then
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  echo "$sum  $file" | sha256sum -c --quiet - || {
    echo "checksum mismatch for $url" >&2
    rm -f "$file"
    exit 1
  }
}

fetch https://repo1.maven.org/maven2/net/sf/saxon/Saxon-HE/10.9/Saxon-HE-10.9.jar \
  saxon.jar 491d8edf4ec811d15c2b2417b007218b9b938f15e4dfbad004025beb4e70e960
fetch https://repo1.maven.org/maven2/name/dmaus/schxslt/schxslt/1.10.1/schxslt-1.10.1.jar \
  schxslt.jar 4f4f21edab7b37f96ad59ae12a344d3510f1092ac46b6d81a4efa0120b73cb58
fetch https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-1.3.17/en16931-ubl-1.3.17.zip \
  en16931-ubl.zip bf02a0e3f6cbe692a4a28e70be7bdcaded5612b4169b543e13d6cb4f33c29e92
fetch https://raw.githubusercontent.com/OpenPeppol/peppol-bis-invoice-3/3.0.22/rules/sch/PEPPOL-EN16931-UBL.sch \
  peppol-ubl.sch f637444fab75a6da7e5004f94a6de8e71383ef5658dafe6c68925103b17ea148

saxon() { java -jar "$tools/saxon.jar" "$@"; }

if [ ! -d "$tools/cen" ]; then
  mkdir -p "$tools/cen" && (cd "$tools/cen" && jar xf ../en16931-ubl.zip)
fi
if [ ! -d "$tools/schxslt" ]; then
  mkdir -p "$tools/schxslt" && (cd "$tools/schxslt" && jar xf ../schxslt.jar)
fi
cen_xslt=$(find "$tools/cen" -name 'EN16931-UBL-validation.xslt' | head -n 1)
pipeline=$(find "$tools/schxslt" -path '*2.0*' -name 'pipeline-for-svrl.xsl' | head -n 1)
test -n "$cen_xslt" && test -n "$pipeline"
if [ ! -f "$tools/peppol-ubl.xsl" ]; then
  saxon -s:"$tools/peppol-ubl.sch" -xsl:"$pipeline" -o:"$tools/peppol-ubl.xsl"
fi

# Prints "<flag> <id/text>" for each failed assertion in an SVRL report.
report() {
  tr '\n' ' ' <"$1" |
    grep -o '<svrl:failed-assert[^>]*>.\{0,400\}' |
    sed -E 's/.*flag="([a-z]+)".*<svrl:text>([^<]*).*/\1 \2/' || true
}

shopt -s nullglob
files=("$xml_dir"/*.xml)
if [ ${#files[@]} -eq 0 ]; then
  echo "no XML files in $xml_dir" >&2
  exit 1
fi

fatal=0
for f in "${files[@]}"; do
  for rules in cen peppol; do
    xsl=$cen_xslt
    [ "$rules" = peppol ] && xsl=$tools/peppol-ubl.xsl
    svrl=${f%.xml}.$rules.svrl
    saxon -s:"$f" -xsl:"$xsl" -o:"$svrl"
    lines=$(report "$svrl")
    count=$(printf '%s\n' "$lines" | grep -c '^fatal ' || true)
    warnings=$(printf '%s\n' "$lines" | grep -c '^warning ' || true)
    echo "$(basename "$f") [$rules]: $count fatal, $warnings warnings"
    if [ -n "$lines" ]; then printf '%s\n' "$lines" | sed 's/^/  /'; fi
    fatal=$((fatal + count))
  done
done

if [ "$fatal" -gt 0 ]; then
  echo "FAILED: $fatal fatal assertion(s)" >&2
  exit 1
fi
echo "All ${#files[@]} e-invoices pass EN 16931 and Peppol BIS 3.0"
