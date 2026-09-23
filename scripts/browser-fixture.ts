// Optional synthetic fixture for repeatable manual browser acceptance checks.
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const token = (await readFile(".local/client-token", "utf8")).trim();
const base = process.env.APP_ORIGIN ?? "http://127.0.0.1:4310";
async function post(path: string, body: unknown) {
  const r = await fetch(base + "/api/client" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const s = await post("/sessions", {
  sourceId: randomUUID(),
  title: "Untrusted text · browser fixture",
  fixture: true,
  caseRef: "BROWSER-CHECK",
});
const unsafe =
  '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
await post(`/sessions/${s.id}/events`, {
  events: [
    {
      eventId: "xss-fixture",
      sourceId: "browser-fixture-chain",
      sequence: 1,
      sourceTime: new Date().toISOString(),
      raw: { tool: "Bash", outcome: "observed", message: unsafe },
    },
  ],
});
const request = await post("/requests", {
  operationId: randomUUID(),
  sessionId: s.id,
  tool: "Bash",
  arguments: { command: unsafe },
  context: unsafe,
  ttlSeconds: 3600,
});
await writeFile(
  ".local/browser-fixture.json",
  JSON.stringify({ session: s.id, request: request.id }, null, 2),
);
console.log(
  "Synthetic HTML fixture created. Inspect request and event: markup must display literally, with no image or script element.",
);
