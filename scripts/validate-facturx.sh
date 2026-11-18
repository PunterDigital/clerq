#!/usr/bin/env bash
# Validates every *.pdf in a folder as a Factur-X / ZUGFeRD invoice (card
# #5041) with Mustang: veraPDF's PDF/A-3b checks on the PDF, and the
# Factur-X XSD + EN 16931 Schematron on the embedded factur-x.xml. Fails
# unless every file is reported valid. Needs Java 17+ and curl.
#
#   scripts/validate-facturx.sh <pdf folder> [tools folder]
#
# Mustang-CLI 2.26.0 (Apache-2.0, bundles veraPDF) is a CI tool only;
# nothing here ships in Clerq.
set -euo pipefail

pdf_dir=${1:?usage: validate-facturx.sh <pdf folder> [tools folder]}
tools=${2:-${RUNNER_TEMP:-/tmp}/einvoice-tools}
mkdir -p "$tools"

jar=$tools/mustang-cli-2.26.0.jar
url=https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/2.26.0/Mustang-CLI-2.26.0.jar
if [ ! -f "$jar" ]; then
  curl -fsSL --retry 3 -o "$jar.part" "$url"
  mv "$jar.part" "$jar"
fi
echo "42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736  $jar" | sha256sum -c --quiet - || {
  echo "checksum mismatch for $url" >&2
  rm -f "$jar"
  exit 1
}

shopt -s nullglob
files=("$pdf_dir"/*.pdf)
if [ ${#files[@]} -eq 0 ]; then
  echo "no PDF files in $pdf_dir" >&2
  exit 1
fi

failed=0
for f in "${files[@]}"; do
  report=${f%.pdf}.mustang.xml
  # Mustang prints its log on stderr and the XML report on stdout; its
  # exit code isn't a reliable verdict, the report's summary is.
  java -jar "$jar" --no-notices --action validate --source "$f" >"$report" 2>"${f%.pdf}.mustang.log" || true
  # The last <summary> is the overall verdict (PDF and XML both valid).
  verdict=$(grep -o '<summary status="[a-z]*"' "$report" | tail -n 1 | sed -E 's/.*"([a-z]+)"/\1/' || true)
  pdfa=$(grep -o 'flavour=[0-9a-z]*, totalAssertions=[0-9]*, assertions=\[[^]]*\], isCompliant=[a-z]*' "$report" | head -n 1 || true)
  errors=$(grep -c '<error' "$report" || true)
  warnings=$(grep -c '<warning' "$report" || true)
  echo "$(basename "$f"): ${verdict:-no report} ($errors errors, $warnings warnings) [$pdfa]"
  grep -o '<\(error\|warning\)[^>]*>[^<]*' "$report" | sed -E 's/<([a-z]+)[^>]*>/  \1: /' || true
  if [ "$verdict" != valid ] || [ "$errors" -gt 0 ]; then
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "FAILED: $failed of ${#files[@]} PDF(s) are not valid Factur-X" >&2
  exit 1
fi
echo "All ${#files[@]} PDFs are valid PDF/A-3b Factur-X (EN 16931)"
