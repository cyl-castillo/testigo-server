import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RequestRecord } from "../shared/api.js";
const base = process.env.APP_ORIGIN ?? "http://127.0.0.1:4310";
const token =
  process.env.CLIENT_TOKEN ??
  (await readFile(".local/client-token", "utf8")).trim();
async function api(path: string, body?: unknown) {
  const response = await fetch(base + "/api/client" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}
const run = randomUUID().slice(0, 8),
  caseRef = `DEMO-${run}`;
const a = await api("/sessions", {
  sourceId: `demo-a-${run}`,
  title: "Release review · synthetic",
  caseRef,
  fixture: true,
});
const b = await api("/sessions", {
  sourceId: `demo-b-${run}`,
  title: "Follow-up inspection · synthetic",
  caseRef,
  fixture: true,
});
const event = (n: number) => ({
  eventId: `event-${n}`,
  sourceId: "synthetic-chain-a",
  sequence: n,
  sourceTime: new Date().toISOString(),
  raw: {
    tool: "Bash",
    outcome: "observed",
    message: `Synthetic observation ${n}`,
    provenance: "fixture",
    source_hash: `synthetic-hash-${n}`,
    signature: "unsupported synthetic signature",
  },
});
const first = event(1),
  third = event(3);
await api(`/sessions/${a.id}/events`, { events: [first, third] });
console.log(
  "Idempotent event retry:",
  await api(`/sessions/${a.id}/events`, { events: [first] }),
);
await api(`/sessions/${a.id}/events`, { events: [event(2), event(5)] });
await api(`/sessions/${b.id}/events`, {
  events: [
    {
      ...event(1),
      sourceId: "synthetic-chain-b",
      raw: {
        tool: "PowerShell",
        outcome: "observed",
        message: '<img src=x onerror="alert(1)"> is untrusted text, not HTML.',
      },
    },
  ],
});
const request = (label: string, command: string, ttlSeconds = 3600) =>
  api("/requests", {
    operationId: `${run}-${label}`,
    sessionId: a.id,
    tool: "Bash",
    arguments: { command },
    cwd: "/synthetic/workspace",
    environment: "demo (client supplied)",
    context: `Synthetic fixture: ${label}. No shell command will be executed.`,
    ttlSeconds,
  }) as Promise<RequestRecord>;
const permitted = await request("permitted", "git status");
const duplicate = await request("permitted", "git status");
if (permitted.id !== duplicate.id) throw new Error("Idempotency failed");
const denied = await request("denied", "testigo-demo destroy sample-data");
const approved = await request(
  "approve-in-dashboard",
  "git push origin demo-approved",
);
const rejected = await request(
  "reject-in-dashboard",
  "git push origin demo-rejected",
);
const expired = await request("expiry", "git push origin demo-expired", 1);
await api(`/sessions/${b.id}/complete`, {});
const manifest = {
  caseRef,
  sessions: [a.id, b.id],
  permitted: permitted.id,
  denied: denied.id,
  approve: approved.id,
  reject: rejected.id,
  expired: expired.id,
};
await writeFile(
  ".local/latest-simulation.json",
  JSON.stringify(manifest, null, 2),
);
console.log(
  `Open ${base} → Approvals. Approve demo-approved and reject demo-rejected.\nCase: ${caseRef}\nPermission never overrides native tool permissions. No commands are executed.`,
);
async function report(r: RequestRecord) {
  const claim = await api(`/requests/${r.id}/claim`, { digest: r.digest });
  await api(`/requests/${r.id}/report`, {
    claimToken: claim.claimToken,
    simulated: true,
    outcome: "succeeded",
    details: "Simulated completion only. No shell process was started.",
  });
}
await report(permitted);
const remaining = new Set([approved.id, rejected.id]);
const deadline = Date.now() + 60 * 60 * 1000;
while (remaining.size && Date.now() < deadline) {
  for (const rid of remaining) {
    const r = (await api(`/requests/${rid}`)) as RequestRecord;
    if (r.state === "approved") {
      await report(r);
      remaining.delete(rid);
      console.log(
        `${r.payload.arguments.command}: approved; simulated completion recorded separately.`,
      );
    } else if (r.state !== "pending") {
      remaining.delete(rid);
      console.log(`${r.payload.arguments.command}: ${r.state}.`);
    }
  }
  if (remaining.size) await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log("Expiry fixture:", (await api(`/requests/${expired.id}`)).state);
await api(`/sessions/${a.id}/complete`, {});
console.log("Simulation finished. Both sessions are complete.");
