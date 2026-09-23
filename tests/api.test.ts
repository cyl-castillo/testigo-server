import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { createPool, migrate } from "../src/db.js";
import { hash, passwordHash, secret, digest } from "../src/crypto.js";
import { demoRules, evaluate } from "../src/policy.js";
import { requestSchema, type Rule } from "../shared/api.js";
import { portable } from "../scripts/portable.js";
import type pg from "pg";
import { retention } from "../src/retention.js";

let pool: pg.Pool, server: Server, base: string;
let db: Awaited<ReturnType<typeof portable>>["db"], databaseUrl: string;
let admin: Browser, reviewer: Browser;
const origin = "http://127.0.0.1:4310",
  sessionSecret = secret(),
  password = secret();
const tokenA = secret(),
  tokenB = secret(),
  clientA = randomUUID(),
  clientB = randomUUID();
type Browser = { cookie: string; csrf: string };
async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    browser?: Browser;
    origin?: string;
    noCsrf?: boolean;
  } = {},
) {
  const response = await fetch(base + "/api" + path, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.browser
        ? {
            Cookie: options.browser.cookie,
            ...(!options.noCsrf
              ? { "X-CSRF-Token": options.browser.csrf }
              : {}),
          }
        : {}),
      Origin: options.origin ?? origin,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie"),
  };
}
async function login(email: string): Promise<Browser> {
  const r = await api("/login", { body: { email, password } });
  assert.equal(r.status, 200);
  assert.match(r.cookie!, /HttpOnly/i);
  assert.match(r.cookie!, /SameSite=Strict/i);
  return { cookie: r.cookie!.split(";")[0], csrf: r.body.csrf };
}
async function start() {
  const app = await buildApp(pool, { origin, sessionSecret, secure: false });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function sessionFor(token = tokenA) {
  const r = await api("/client/sessions", {
    token,
    body: {
      sourceId: randomUUID(),
      title: "Synthetic test",
      caseRef: "CASE-INTEGRATION",
      fixture: true,
    },
  });
  assert.equal(r.status, 200);
  return r.body;
}
async function request(
  command = "git push origin test",
  ttlSeconds = 600,
  sessionId?: string,
  token = tokenA,
  operationId = randomUUID(),
) {
  const sid = sessionId ?? (await sessionFor(token)).id;
  const body = {
    operationId,
    sessionId: sid,
    tool: "Bash",
    arguments: { command },
    context: "Synthetic integration fixture",
    ttlSeconds,
  };
  const r = await api("/client/requests", { token, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, input: body };
}
async function decide(r: any, decision = "approved", browser = reviewer) {
  return api(`/requests/${r.id}/decision`, {
    browser,
    body: {
      decision,
      reason: "Reviewed in integration test",
      digest: r.digest,
    },
  });
}
async function policy(rules: Rule[]) {
  const current = await api("/policy", { browser: admin });
  return api("/policy", {
    method: "PUT",
    browser: admin,
    body: { baseVersion: current.body.id, rules },
  });
}
before(async () => {
  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(resolve(".local/test-pg-"));
  const portableDb = await portable(directory, 55433);
  db = portableDb.db;
  databaseUrl = portableDb.url;
  await db.start();
  pool = createPool(databaseUrl);
  await migrate(pool);
  const p = await passwordHash(password);
  for (const role of ["admin", "reviewer"])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)",
      [randomUUID(), `${role}@test.local`, p, role],
    );
  for (const [id, token, name] of [
    [clientA, tokenA, "Client A"],
    [clientB, tokenB, "Client B"],
  ])
    await pool.query(
      "INSERT INTO clients(id,name,token_hash) VALUES($1,$2,$3)",
      [id, name, hash(token)],
    );
  await start();
  admin = await login("admin@test.local");
  reviewer = await login("reviewer@test.local");
  console.log(
    "Integration database:",
    (await pool.query("SELECT version() AS version")).rows[0].version,
  );
});
after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) await pool.end();
  if (db) await db.stop();
});

test("browser roles, client credentials, cookies, origin and CSRF are separated", async () => {
  assert.equal((await api("/clients")).status, 401);
  assert.equal((await api("/clients", { token: tokenA })).status, 401);
  assert.equal(
    (await api("/client/sessions", { browser: admin, body: {} })).status,
    401,
  );
  assert.equal(
    (
      await api("/clients", {
        browser: reviewer,
        body: { name: "unauthorized" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/clients", {
        browser: admin,
        noCsrf: true,
        body: { name: "csrf" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/clients", {
        browser: admin,
        origin: "https://attacker.invalid",
        body: { name: "origin" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await api("/policy", { method: "PUT", browser: reviewer, body: {} }))
      .status,
    403,
  );
  const r = await request();
  assert.equal(
    (
      await api(`/requests/${r.id}/decision`, {
        token: tokenA,
        body: { decision: "approved", digest: r.digest },
      })
    ).status,
    401,
  );
  assert.equal(
    (await api("/login", { body: { email: "missing@test.local", password } }))
      .status,
    401,
  );
});
test("literal matching, boundary checks, PowerShell and precedence fail closed", async () => {
  const input = (command: string) =>
    requestSchema.parse({
      operationId: "x",
      sessionId: randomUUID(),
      tool: "Bash",
      arguments: { command },
    });
  assert.equal(evaluate(demoRules, input("git status")).action, "permit");
  for (const s of [
    " git status",
    "git status; echo danger",
    "echo git status",
    "git status\n",
    "GIT STATUS",
    "git pushy",
  ])
    assert.equal(evaluate(demoRules, input(s)).action, "approval");
  assert.deepEqual(evaluate(demoRules, input("git pushy")).matches, []);
  assert.deepEqual(evaluate(demoRules, input("git push; echo x")).matches, [
    "push-review",
  ]);
  assert.equal((await request("git status")).evaluation, "permit");
  assert.equal((await request("testigo-demo destroy sample")).state, "denied");
  assert.equal((await request("unknown-shell-command")).state, "pending");
  const ps = await api("/client/requests", {
    token: tokenA,
    body: {
      operationId: randomUUID(),
      sessionId: (await sessionFor()).id,
      tool: "PowerShell",
      arguments: { command: "git status" },
    },
  });
  assert.equal(ps.body.state, "approved");
  const permit: Rule = {
    id: "allow",
    enabled: true,
    tool: "*",
    matcher: "exact",
    value: "overlap",
    action: "permit",
  };
  const approval: Rule = { ...permit, id: "review", action: "approval" },
    deny: Rule = { ...permit, id: "block", action: "deny" };
  assert.equal((await policy([permit, approval])).status, 200);
  assert.equal((await request("overlap")).state, "pending");
  assert.equal((await policy([permit, approval, deny])).status, 200);
  assert.equal((await request("overlap")).state, "denied");
  assert.equal((await policy([{ ...permit, matcher: "prefix" }])).status, 400);
  assert.equal((await policy(demoRules)).status, 200);
});
test("clients cannot read, append, complete, claim, cancel or report another client records", async () => {
  const s = await sessionFor();
  const r = await request("git status", 600, s.id);
  for (const [path, body] of [
    [`/sessions/${s.id}`, undefined],
    [
      `/sessions/${s.id}/events`,
      {
        events: [
          {
            eventId: "x",
            sourceId: "s",
            sequence: 1,
            sourceTime: new Date().toISOString(),
            raw: {},
          },
        ],
      },
    ],
    [`/sessions/${s.id}/complete`, {}],
    [`/requests/${r.id}`, undefined],
    [`/requests/${r.id}/claim`, { digest: r.digest }],
    [`/requests/${r.id}/cancel`, {}],
    [
      `/requests/${r.id}/report`,
      {
        claimToken: secret(),
        simulated: true,
        outcome: "succeeded",
        details: "",
      },
    ],
  ] as const) {
    assert.equal(
      (await api("/client" + path, { token: tokenB, body })).status,
      404,
    );
  }
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenB,
        body: { ...r.input, operationId: randomUUID() },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await api("/client/sessions", {
        token: tokenA,
        body: {
          sourceId: "forged",
          title: "x",
          fixture: true,
          clientId: clientB,
        },
      })
    ).status,
    400,
  );
});
test("session idempotency, event retries, conflict rollback, source gaps, late arrival and original provenance", async () => {
  const input = {
    sourceId: randomUUID(),
    title: "Original <script>window.pwned=1</script>",
    fixture: true,
    caseRef: "TICKET",
  };
  const a = await api("/client/sessions", { token: tokenA, body: input }),
    b = await api("/client/sessions", { token: tokenA, body: input });
  assert.equal(a.body.id, b.body.id);
  assert.equal(
    (
      await api("/client/sessions", {
        token: tokenA,
        body: { ...input, title: "changed" },
      })
    ).status,
    409,
  );
  const s = a.body.id;
  const e = (n: number, sourceId = "chain-a") => ({
    eventId: `event-${n}`,
    sourceId,
    sequence: n,
    sourceTime: "2026-09-22T12:00:00Z",
    raw: {
      tool: "Bash",
      outcome: "observed",
      hash: "retain-this-hash",
      signature: "unsupported",
      message: '<img src=x onerror="window.pwned=1">',
    },
  });
  const ingest = (events: unknown[]) =>
    api(`/client/sessions/${s}/events`, { token: tokenA, body: { events } });
  assert.equal((await ingest([e(1), e(3)])).body.accepted, 2);
  assert.equal((await ingest([e(1)])).body.duplicates, 1);
  assert.equal((await ingest([e(2), e(5), e(1, "chain-b")])).body.accepted, 3);
  const page = (await api(`/sessions/${s}/events`, { browser: reviewer })).body;
  assert.equal(page.verification, "not verified");
  assert.deepEqual(page.gaps, [
    { source_id: "chain-a", missing_from: 4, missing_to: 4 },
  ]);
  assert.equal(page.sources.length, 2);
  assert.equal(page.events.find((v: any) => v.sequence === 2).late, true);
  assert.deepEqual(page.events[0].original, e(1));
  assert.equal(
    (await ingest([e(6), { ...e(1), raw: { changed: true } }])).status,
    409,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM events WHERE session_id=$1 AND sequence=6",
        [s],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await ingest([{ ...e(3), eventId: "different-id" }])).status,
    409,
  );
  assert.equal(
    (await ingest(Array.from({ length: 51 }, (_, i) => e(i + 1)))).status,
    400,
  );
  assert.ok(
    (
      await pool.query("SELECT ingestion_errors FROM clients WHERE id=$1", [
        clientA,
      ])
    ).rows[0].ingestion_errors >= 3,
  );
  assert.equal(
    (await api(`/sessions/${s}/events?tool=PowerShell`, { browser: reviewer }))
      .body.events.length,
    0,
  );
});
test("concurrent idempotent submissions bind all immutable input and reject changed payload", async () => {
  const s = await sessionFor();
  const body = {
    operationId: randomUUID(),
    sessionId: s.id,
    tool: "Bash",
    arguments: { command: "git push origin test", nested: { a: 1, b: 2 } },
    cwd: "/one",
    environment: "demo",
    context: "context",
    ttlSeconds: 600,
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      api("/client/requests", { token: tokenA, body }),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: {
          ...body,
          arguments: {
            nested: { b: 2, a: 1 },
            command: body.arguments.command,
          },
        },
      })
    ).status,
    200,
  );
  for (const changed of [
    { cwd: "/two" },
    { context: "different" },
    { environment: "prod" },
    { ttlSeconds: 601 },
    { tool: "PowerShell" },
    { arguments: { command: "changed" } },
  ])
    assert.equal(
      (
        await api("/client/requests", {
          token: tokenA,
          body: { ...body, ...changed },
        })
      ).status,
      409,
    );
  assert.equal(results[0].body.digest, digest(requestSchema.parse(body)));
});
test("policy publication invalidates undecided requests, preserves decisions and rejects stale edits", async () => {
  const pending = await request(),
    approved = await request();
  await decide(approved);
  const current = (await api("/policy", { browser: admin })).body;
  const update = await policy(demoRules);
  assert.equal(update.status, 200);
  const cancelled = await api(`/client/requests/${pending.id}`, {
    token: tokenA,
  });
  assert.equal(cancelled.body.state, "cancelled");
  assert.equal(cancelled.body.policy_version, current.id);
  assert.equal((await decide(pending)).status, 409);
  assert.equal(
    (await api("/client/requests", { token: tokenA, body: pending.input })).body
      .state,
    "cancelled",
  );
  const resubmitted = await request();
  assert.equal(resubmitted.policy_version, update.body.id);
  assert.equal(
    (await api(`/client/requests/${approved.id}`, { token: tokenA })).body
      .state,
    "approved",
  );
  assert.equal(
    (
      await api("/policy", {
        browser: admin,
        method: "PUT",
        body: { baseVersion: current.id, rules: demoRules },
      })
    ).status,
    409,
  );
});
test("simultaneous reviewers produce one immutable decision and one audit entry", async () => {
  const r = await request();
  const results = await Promise.all([
    decide(r, "approved", reviewer),
    decide(r, "denied", admin),
    decide(r, "approved", admin),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  assert.equal(
    (
      await pool.query("SELECT * FROM approval_decisions WHERE request_id=$1", [
        r.id,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM audit_entries WHERE target=$1 AND action IN ('request.approved','request.denied')",
        [r.id],
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    pool.query(
      "UPDATE approval_decisions SET reason='edited' WHERE request_id=$1",
      [r.id],
    ),
    /immutable/,
  );
});
test("single-use claim and execution report are distinct, immutable and scoped to the digest", async () => {
  const r = await request();
  await decide(r);
  assert.equal(
    (
      await pool.query("SELECT * FROM execution_reports WHERE request_id=$1", [
        r.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await api(`/client/requests/${r.id}/claim`, {
        token: tokenA,
        body: { digest: "0".repeat(64) },
      })
    ).status,
    409,
  );
  const claims = await Promise.all(
    Array.from({ length: 10 }, () =>
      api(`/client/requests/${r.id}/claim`, {
        token: tokenA,
        body: { digest: r.digest },
      }),
    ),
  );
  assert.equal(claims.filter((c) => c.status === 200).length, 1);
  assert.equal(claims.filter((c) => c.status === 409).length, 9);
  const report = {
    claimToken: claims.find((c) => c.status === 200)!.body.claimToken,
    simulated: true,
    outcome: "succeeded",
    details: "Never executed",
  };
  assert.equal(
    (
      await api(`/client/requests/${r.id}/report`, {
        token: tokenA,
        body: { ...report, claimToken: secret() },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/client/requests/${r.id}/report`, {
        token: tokenA,
        body: { ...report, simulated: false },
      })
    ).status,
    400,
  );
  const a = await api(`/client/requests/${r.id}/report`, {
      token: tokenA,
      body: report,
    }),
    b = await api(`/client/requests/${r.id}/report`, {
      token: tokenA,
      body: report,
    });
  assert.equal(a.body.id, b.body.id);
  assert.equal(
    (
      await api(`/client/requests/${r.id}/report`, {
        token: tokenA,
        body: { ...report, details: "edited" },
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/client/requests/${r.id}`, { token: tokenA })).body.claim_hash,
    undefined,
  );
  const denied = await request("testigo-demo destroy sample");
  assert.equal(
    (
      await api(`/client/requests/${denied.id}/claim`, {
        token: tokenA,
        body: { digest: denied.digest },
      })
    ).status,
    409,
  );
});
test("expiry enforced on read, review and claim without a cleanup job", async () => {
  const pending = await request("git push origin expiry", 1),
    permitted = await request("git status", 1);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal((await decide(pending)).status, 409);
  assert.equal(
    (
      await api(`/client/requests/${permitted.id}/claim`, {
        token: tokenA,
        body: { digest: permitted.digest },
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/client/requests/${pending.id}`, { token: tokenA })).body.state,
    "expired",
  );
  assert.equal(
    (await api(`/client/requests/${permitted.id}`, { token: tokenA })).body
      .state,
    "expired",
  );
});
test("revocation and session completion cancel unclaimed authorizations", async () => {
  const s = await sessionFor(),
    r = await request("git status", 600, s.id);
  assert.equal(
    (
      await api(`/client/sessions/${s.id}/complete`, {
        token: tokenA,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await api(`/client/requests/${r.id}`, { token: tokenA })).body.state,
    "cancelled",
  );
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: { ...r.input, operationId: randomUUID() },
      })
    ).status,
    409,
  );
  const enrollment = await api("/clients", {
    browser: admin,
    body: { name: "Revocation fixture" },
  });
  assert.equal(enrollment.status, 201);
  const token = enrollment.body.token;
  assert.equal(
    (await api("/clients", { browser: admin })).body.find(
      (c: any) => c.id === enrollment.body.id,
    ).token,
    undefined,
  );
  const q = await request("git status", 600, undefined, token);
  assert.equal(
    (
      await api(`/clients/${enrollment.body.id}/revoke`, {
        browser: admin,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(`/client/requests/${q.id}/claim`, {
        token,
        body: { digest: q.digest },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await pool.query("SELECT state FROM execution_requests WHERE id=$1", [
        q.id,
      ])
    ).rows[0].state,
    "cancelled",
  );
});
test("human rejection and client cancellation never permit claims", async () => {
  const r = await request();
  assert.equal((await decide(r, "denied")).status, 200);
  assert.equal((await decide(r, "approved")).status, 409);
  assert.equal(
    (
      await api(`/client/requests/${r.id}/claim`, {
        token: tokenA,
        body: { digest: r.digest },
      })
    ).status,
    409,
  );
  const cancelled = await request();
  assert.equal(
    (
      await api(`/client/requests/${cancelled.id}/cancel`, {
        token: tokenA,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal((await decide(cancelled)).status, 409);
});
test("source, policy, request bindings and audit data cannot be silently rewritten", async () => {
  const r = await request();
  await assert.rejects(
    pool.query("UPDATE execution_requests SET payload='{}' WHERE id=$1", [
      r.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE policy_versions SET rules='[]' WHERE id=$1", [
      r.policy_version,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE events SET original='{}'"),
    /immutable/,
  );
  await assert.rejects(pool.query("DELETE FROM audit_entries"), /immutable/);
});
test("bounded input rejects deep JSON, NUL characters, oversized bodies and invalid TTL", async () => {
  const s = await sessionFor();
  const input = {
    operationId: randomUUID(),
    sessionId: s.id,
    tool: "Bash",
    arguments: { command: "git status" },
  };
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: { ...input, ttlSeconds: 0 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: { ...input, arguments: { command: "git\0status" } },
      })
    ).status,
    400,
  );
  let nested: unknown = {};
  for (let i = 0; i < 30; i++) nested = { child: nested };
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: { ...input, arguments: { command: "git status", nested } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/client/requests", {
        token: tokenA,
        body: { ...input, context: "x".repeat(300000) },
      })
    ).status,
    413,
  );
});
test("retention dry-run preserves source data; explicit purge removes whole sessions and leaves a tombstone", async () => {
  const s = await sessionFor();
  await api(`/client/sessions/${s.id}/events`, {
    token: tokenA,
    body: {
      events: [
        {
          eventId: "retention-event",
          sourceId: "retention-chain",
          sequence: 1,
          sourceTime: new Date().toISOString(),
          raw: { synthetic: true },
        },
      ],
    },
  });
  await api(`/client/sessions/${s.id}/complete`, { token: tokenA, body: {} });
  const protectedSession = await sessionFor();
  const r = await request("git status", 600, protectedSession.id);
  await api(`/client/requests/${r.id}/claim`, {
    token: tokenA,
    body: { digest: r.digest },
  });
  await api(`/client/sessions/${protectedSession.id}/complete`, {
    token: tokenA,
    body: {},
  });
  await pool.query(
    "UPDATE sessions SET completed_at=now()-interval '60 days' WHERE id=ANY($1::uuid[])",
    [[s.id, protectedSession.id]],
  );
  const dry = await retention(pool, 30);
  assert.ok(dry.sessions.some((v) => v.id === s.id));
  assert.ok(!dry.sessions.some((v) => v.id === protectedSession.id));
  assert.equal(
    (await pool.query("SELECT * FROM events WHERE session_id=$1", [s.id]))
      .rowCount,
    1,
  );
  await retention(pool, 30, true);
  assert.equal(
    (await pool.query("SELECT * FROM sessions WHERE id=$1", [s.id])).rowCount,
    0,
  );
  assert.equal(
    (await pool.query("SELECT * FROM events WHERE session_id=$1", [s.id]))
      .rowCount,
    0,
  );
  const tombstone = (
    await pool.query(
      "SELECT * FROM audit_entries WHERE target=$1 AND action='session.purged'",
      [s.id],
    )
  ).rows[0];
  assert.equal(tombstone.detail.sourceDataDeleted, true);
  assert.equal(tombstone.detail.eventsRemoved, "1");
  assert.equal(
    (
      await pool.query("SELECT * FROM sessions WHERE id=$1", [
        protectedSession.id,
      ])
    ).rowCount,
    1,
  );
});
test("application and PostgreSQL restart preserve sessions, pending requests and browser login", async () => {
  const s = await sessionFor(),
    r = await request("git push origin restart", 600, s.id);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await db.stop();
  await db.start();
  pool = createPool(databaseUrl);
  await migrate(pool);
  await start();
  assert.equal(
    (await api(`/client/sessions/${s.id}`, { token: tokenA })).body.id,
    s.id,
  );
  assert.equal(
    (await api(`/client/requests/${r.id}`, { token: tokenA })).body.state,
    "pending",
  );
  assert.equal((await api("/me", { browser: admin })).body.user.role, "admin");
  assert.equal((await decide(r)).status, 200);
});
