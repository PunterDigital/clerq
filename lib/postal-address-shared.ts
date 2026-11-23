// Structured postal address for e-invoicing (EN 16931 BG-5 / BG-8): the
// country list, the stored shape and the free-text suggestion, with no zod.
// Client components import from here so the zod runtime stays out of their
// bundles (#5695); the input schema is in postal-address.ts, which
// re-exports everything below.

// ISO 3166-1 alpha-2, the officially assigned codes (249). EN 16931 uses this
// list for BT-40 / BT-55 / BT-80.
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT",
  "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI",
  "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY",
  "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK",
  "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL",
  "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR",
  "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS",
  "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW",
  "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP",
  "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM",
  "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF",
  "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW",
  "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
] as const;

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

export function isCountryCode(value: string): boolean {
  return COUNTRY_CODE_SET.has(value);
}

export type CountryOption = { code: string; label: string };

// The stored shape: every part present, empty parts as null.
export type PostalAddress = {
  street: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country: string;
};

// -- Suggesting a split from the free-text address ---------------------------

// A best-effort guess at the structured parts of a free-text address. Nothing
// stores it: the forms show it and the user decides whether to use it. Any
// part (the country included) may be missing.
export type AddressSuggestion = {
  street: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country: string | null;
};

// Local and common names the English display names don't cover.
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  usa: "US",
  us: "US",
  "united states of america": "US",
  "united states": "US",
  america: "US",
  deutschland: "DE",
  germany: "DE",
  nederland: "NL",
  holland: "NL",
  "the netherlands": "NL",
  netherlands: "NL",
  espana: "ES",
  italia: "IT",
  polska: "PL",
  osterreich: "AT",
  schweiz: "CH",
  suisse: "CH",
  svizzera: "CH",
  belgique: "BE",
  belgie: "BE",
  eire: "IE",
  "republic of ireland": "IE",
  "czech republic": "CZ",
  "ceska republika": "CZ",
  cesko: "CZ",
  slovensko: "SK",
  "slovak republic": "SK",
  danmark: "DK",
  sverige: "SE",
  norge: "NO",
  suomi: "FI",
  magyarorszag: "HU",
  hrvatska: "HR",
  slovenija: "SI",
  turkey: "TR",
  turkiye: "TR",
  "south korea": "KR",
};

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countryLookup(options: CountryOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of options) {
    map.set(normalizeName(option.label), option.code);
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    map.set(alias, code);
  }
  return map;
}

function countryFromLine(
  line: string,
  lookup: Map<string, string>,
): string | null {
  // A bare upper-case code on its own line ("DE").
  if (/^[A-Z]{2}$/.test(line) && isCountryCode(line)) return line;
  return lookup.get(normalizeName(line)) ?? null;
}

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
    "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA " +
    "WV WI WY PR GU VI AS MP"
  ).split(" "),
);
const CA_PROVINCES = new Set(
  "AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "),
);
// Old European postcode prefixes ("D-10115 Berlin", "A-1010 Wien").
const POSTCODE_PREFIX_COUNTRY: Record<string, string> = {
  D: "DE",
  A: "AT",
  F: "FR",
  B: "BE",
  L: "LU",
  I: "IT",
  CH: "CH",
  NL: "NL",
  E: "ES",
  P: "PT",
  DK: "DK",
  S: "SE",
  N: "NO",
  FIN: "FI",
  CZ: "CZ",
  SK: "SK",
  PL: "PL",
};

type PostcodeMatch = {
  postcode: string;
  // The town on the same line, if the line has one.
  city: string | null;
  region: string | null;
  country: string | null;
};

function ukPostcode(raw: string): string {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function matchPostcodeLine(line: string): PostcodeMatch | null {
  let m: RegExpMatchArray | null;
  // United Kingdom: "Bristol BS1 4QA", "BS1 4QA", "London, SW1A 2AA".
  m = line.match(
    /^(.*?)[,\s]*\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$/i,
  );
  if (m) {
    return {
      postcode: ukPostcode(m[2]),
      city: m[1].trim() || null,
      region: null,
      country: "GB",
    };
  }
  // Ireland (Eircode): "Dublin 2 D02 X285", "D02 X285".
  m = line.match(/^(.*?)[,\s]*\b([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})$/i);
  if (m) {
    return {
      postcode: `${m[2]} ${m[3]}`.toUpperCase(),
      city: m[1].trim() || null,
      region: null,
      country: "IE",
    };
  }
  // United States: "Springfield, IL 62701", "Austin TX 78701-1234".
  m = line.match(/^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m && US_STATES.has(m[2])) {
    return { postcode: m[3], city: m[1].trim(), region: m[2], country: "US" };
  }
  // Canada: "Toronto, ON M5V 2T6".
  m = line.match(/^(.+?),?\s+([A-Z]{2})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i);
  if (m && CA_PROVINCES.has(m[2].toUpperCase())) {
    return {
      postcode: m[3].toUpperCase(),
      city: m[1].trim(),
      region: m[2].toUpperCase(),
      country: "CA",
    };
  }
  // Netherlands: "1012 AB Amsterdam".
  m = line.match(/^(\d{4}\s?[A-Z]{2})\s+(.+)$/);
  if (m) {
    return { postcode: m[1], city: m[2].trim(), region: null, country: "NL" };
  }
  // Poland: "00-950 Warszawa".
  m = line.match(/^(\d{2}-\d{3})\s+(.+)$/);
  if (m) {
    return { postcode: m[1], city: m[2].trim(), region: null, country: "PL" };
  }
  // Portugal: "1000-001 Lisboa".
  m = line.match(/^(\d{4}-\d{3})\s+(.+)$/);
  if (m) {
    return { postcode: m[1], city: m[2].trim(), region: null, country: "PT" };
  }
  // Czechia / Slovakia: "110 00 Praha 1" (either country, so none guessed).
  m = line.match(/^(\d{3}\s\d{2})\s+(.+)$/);
  if (m) {
    return { postcode: m[1], city: m[2].trim(), region: null, country: null };
  }
  // Most of continental Europe: "10115 Berlin", "75001 Paris", "1010 Wien",
  // with an optional old country prefix ("D-10115 Berlin").
  m = line.match(/^(?:([A-Z]{1,3})-)?(\d{4,5})\s+(.+)$/);
  if (m) {
    return {
      postcode: m[2],
      city: m[3].trim(),
      region: null,
      country: m[1] ? (POSTCODE_PREFIX_COUNTRY[m[1]] ?? null) : null,
    };
  }
  return null;
}

// Guesses street / city / postcode / region / country from a free-text
// address. Country names are matched against `countryOptions` (the same list
// the form's dropdown shows, built once on the server) plus common local
// names, so the result is the same wherever it runs.
export function suggestPostalAddress(
  text: string | null | undefined,
  countryOptions: CountryOption[],
): AddressSuggestion | null {
  if (!text?.trim()) return null;
  let lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, "").trim())
    .filter(Boolean);
  if (lines.length === 1) {
    lines = lines[0]
      .split(",")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const lookup = countryLookup(countryOptions);
  let country: string | null = null;
  if (lines.length > 1) {
    const named = countryFromLine(lines[lines.length - 1], lookup);
    if (named) {
      country = named;
      lines = lines.slice(0, -1);
    }
  }

  let city: string | null = null;
  let postcode: string | null = null;
  let region: string | null = null;
  let streetLines = lines;

  for (let i = lines.length - 1; i >= 0; i--) {
    // The first line is the street unless it is the only line left.
    if (i === 0 && lines.length > 1) break;
    const match = matchPostcodeLine(lines[i]);
    if (!match) continue;
    postcode = match.postcode;
    region = match.region;
    country ??= match.country;
    if (match.city) {
      city = match.city;
      streetLines = lines.slice(0, i);
    } else if (i > 1) {
      // Postcode on its own line: the town is the line above it.
      city = lines[i - 1];
      streetLines = lines.slice(0, i - 1);
    } else {
      streetLines = lines.slice(0, i);
    }
    break;
  }

  if (postcode === null && lines.length > 1) {
    // No postcode found: treat the last line as the town.
    city = lines[lines.length - 1];
    streetLines = lines.slice(0, -1);
  }

  const street = streetLines.length > 0 ? streetLines.join("\n") : null;
  if (!street && !city && !postcode && !country) return null;
  return { street, city, postcode, region, country };
}
