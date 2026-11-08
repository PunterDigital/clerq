// A stand-in for OpenRouter's chat completions endpoint, so the E2E suite can
// exercise "Scan with AI" without a key or the network. Playwright starts it
// next to the app (playwright.config.ts) and points OPENROUTER_BASE_URL here.
//
// What it answers depends on the image it is sent. A spec can put a marker in
// the file's bytes (after a PNG's IEND chunk, where browsers ignore it):
//   CLERQ-STUB:FAIL          -> HTTP 500, so the app reports a failed scan
//   CLERQ-STUB:{...json...}  -> that JSON as the model's answer (one line)
// Anything without a marker (e.g. a PDF page the browser turned into a JPEG)
// gets DEFAULT_ANSWER.
import { createServer } from "node:http";

const port = Number(process.env.OPENROUTER_STUB_PORT ?? 3199);

const DEFAULT_ANSWER = {
  description: "Scanned PDF invoice",
  amount: "120.00",
  currency: "EUR",
  vendor: "Stub Supplier",
  category: "Office",
  date: "2026-10-15",
  notes: null,
};

const MARKER = "CLERQ-STUB:";

function answerFor(body) {
  const content = body?.messages?.[1]?.content ?? [];
  const url = content.find((part) => part.type === "image_url")?.image_url?.url;
  if (typeof url !== "string") return { status: 400 };
  const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const text = bytes.toString("latin1");
  const at = text.indexOf(MARKER);
  if (at === -1) return { status: 200, content: JSON.stringify(DEFAULT_ANSWER) };
  const rest = text.slice(at + MARKER.length).split("\n")[0];
  if (rest.startsWith("FAIL")) return { status: 500 };
  return { status: 200, content: rest };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let answer;
    try {
      answer = answerFor(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      answer = { status: 400 };
    }
    if (answer.status !== 200) {
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: answer.status, message: "stub" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ choices: [{ message: { content: answer.content } }] }),
    );
  });
});

server.listen(port, "127.0.0.1");
