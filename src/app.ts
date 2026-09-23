import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { audit, transaction, type Tx } from "./db.js";
import {
  digest,
  hash,
  passwordHash,
  passwordMatches,
  secret,
} from "./crypto.js";
import { evaluate } from "./policy.js";
import {
  id,
  requestSchema,
  sessionSchema,
  eventsSchema,
  policySchema,
} from "../shared/api.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    csrf: string;
  }
}
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; role: string };
      clientId?: string;
    }
  }
}
export interface Config {
  origin: string;
  sessionSecret: string;
  secure: boolean;
  trustProxy?: boolean;
}
class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new Problem(status, message);
};
const paramId = (req: Request) => id.parse(req.params.id);
const csrfSafe = (req: Request) =>
  ["GET", "HEAD", "OPTIONS"].includes(req.method);
const publicRequest = (row: Record<string, unknown>) => {
  const { claim_hash, ...safe } = row;
  return safe;
};

async function expire(tx: Tx) {
  const { rows } = await tx.query(
    "UPDATE execution_requests SET state='expired' WHERE state IN ('pending','approved') AND claimed_at IS NULL AND expires_at<=clock_timestamp() RETURNING id",
  );
  for (const row of rows) await audit(tx, "system", "request.expired", row.id);
}
async function clientLock(tx: Tx, clientId: string) {
  const c = (
    await tx.query("SELECT revoked_at FROM clients WHERE id=$1 FOR UPDATE", [
      clientId,
    ])
  ).rows[0];
  if (!c || c.revoked_at) fail(401, "Client credential revoked");
}
async function ownedSession(tx: Tx, sessionId: string, clientId: string) {
  const s = (
    await tx.query("SELECT * FROM sessions WHERE id=$1 AND client_id=$2", [
      sessionId,
      clientId,
    ])
  ).rows[0];
  if (!s) fail(404, "Session not found");
  return s;
}
async function ownedRequest(tx: Tx, requestId: string, clientId: string) {
  const r = (
    await tx.query(
      "SELECT * FROM execution_requests WHERE id=$1 AND client_id=$2 FOR UPDATE",
      [requestId, clientId],
    )
  ).rows[0];
  if (!r) fail(404, "Request not found");
  return r;
}
export async function buildApp(pool: pg.Pool, config: Config) {
  if (config.sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must have at least 32 characters");
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (req, _res, next) => {
    const queue: { value: unknown; depth: number }[] = [
      { value: req.body, depth: 0 },
      { value: req.query, depth: 0 },
    ];
    while (queue.length) {
      const { value, depth } = queue.pop()!;
      if (depth > 20)
        return next(new Problem(400, "JSON nesting exceeds 20 levels"));
      if (typeof value === "string" && value.includes("\0"))
        return next(new Problem(400, "NUL characters are not supported"));
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key.includes("\0"))
            return next(new Problem(400, "NUL characters are not supported"));
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    next();
  });
  app.use("/api", (req, _res, next) => {
    if (req.headers.origin && req.headers.origin !== config.origin)
      return next(new Problem(403, "Origin rejected"));
    if (
      !csrfSafe(req) &&
      !req.path.startsWith("/client/") &&
      req.headers.origin !== config.origin
    )
      return next(new Problem(403, "Origin required"));
    next();
  });
  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool,
    tableName: "browser_sessions",
    pruneSessionInterval: false,
  });
  app.use(
    session({
      store,
      secret: config.sessionSecret,
      name: "testigo.sid",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: config.secure,
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  const dummyHash = await passwordHash(secret());
  app.post(
    "/api/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 15,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    async (req, res) => {
      const body = z
        .object({
          email: z.string().email().max(200),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(req.body);
      const user = (
        await pool.query("SELECT * FROM users WHERE email=$1", [
          body.email.toLowerCase(),
        ])
      ).rows[0];
      const valid = await passwordMatches(
        body.password,
        user?.password_hash ?? dummyHash,
      );
      if (!user || !valid) return fail(401, "Invalid credentials");
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((e) => (e ? reject(e) : resolve())),
      );
      req.session.userId = user.id;
      req.session.csrf = secret();
      await transaction(pool, (tx) =>
        audit(tx, user.email, "user.login", user.id),
      );
      res.json({
        user: { id: user.id, email: user.email, role: user.role },
        csrf: req.session.csrf,
      });
    },
  );
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      mode: "simulation POC",
      verification: "not verified",
    });
  });
  app.use("/api/client", async (req, _res, next) => {
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith("Bearer ") || bearer.length > 200)
      return fail(401, "Client credential required");
    const client = (
      await pool.query(
        "UPDATE clients SET last_contact=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id",
        [hash(bearer.slice(7))],
      )
    ).rows[0];
    if (!client) return fail(401, "Invalid client credential");
    req.clientId = client.id;
    next();
  });
  app.post("/api/client/sessions", async (req, res) => {
    const data = sessionSchema.parse(req.body);
    const result = await transaction(pool, async (tx) => {
      await clientLock(tx, req.clientId!);
      const existing = (
        await tx.query(
          "SELECT * FROM sessions WHERE client_id=$1 AND source_id=$2",
          [req.clientId, data.sourceId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.title !== data.title ||
          existing.case_ref !== data.caseRef ||
          existing.fixture !== data.fixture
        )
          fail(409, "Source session ID reused with different input");
        return existing;
      }
      const s = (
        await tx.query(
          "INSERT INTO sessions(id,client_id,source_id,title,case_ref,fixture) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            req.clientId,
            data.sourceId,
            data.title,
            data.caseRef,
            data.fixture,
          ],
        )
      ).rows[0];
      await audit(tx, `client:${req.clientId}`, "session.created", s.id, {
        fixture: data.fixture,
      });
      return s;
    });
    res.json(result);
  });
  app.get("/api/client/sessions/:id", async (req, res) => {
    res.json(
      await transaction(pool, (tx) =>
        ownedSession(tx, paramId(req), req.clientId!),
      ),
    );
  });
  app.post("/api/client/sessions/:id/complete", async (req, res) => {
    res.json(
      await transaction(pool, async (tx) => {
        await clientLock(tx, req.clientId!);
        const s = await ownedSession(tx, paramId(req), req.clientId!);
        if (s.status !== "completed") {
          await tx.query(
            "UPDATE sessions SET status='completed',completed_at=now() WHERE id=$1",
            [s.id],
          );
          const cancelled = await tx.query(
            "UPDATE execution_requests SET state='cancelled',cancellation_reason='Session completed' WHERE session_id=$1 AND state IN ('pending','approved') AND claimed_at IS NULL RETURNING id",
            [s.id],
          );
          for (const r of cancelled.rows)
            await audit(
              tx,
              `client:${req.clientId}`,
              "request.cancelled",
              r.id,
              { reason: "Session completed" },
            );
          await audit(tx, `client:${req.clientId}`, "session.completed", s.id);
        }
        return { status: "completed" };
      }),
    );
  });
  app.post("/api/client/sessions/:id/events", async (req, res) => {
    try {
      const data = eventsSchema.parse(req.body);
      const sid = paramId(req);
      const result = await transaction(pool, async (tx) => {
        await clientLock(tx, req.clientId!);
        await ownedSession(tx, sid, req.clientId!);
        let accepted = 0,
          duplicates = 0;
        for (const e of data.events) {
          const d = digest(e);
          const existing = (
            await tx.query(
              "SELECT content_digest FROM events WHERE session_id=$1 AND source_id=$2 AND event_id=$3",
              [sid, e.sourceId, e.eventId],
            )
          ).rows[0];
          if (existing) {
            if (existing.content_digest !== d)
              fail(409, "Event ID has conflicting content");
            duplicates++;
            continue;
          }
          if (
            (
              await tx.query(
                "SELECT 1 FROM events WHERE session_id=$1 AND source_id=$2 AND sequence=$3",
                [sid, e.sourceId, e.sequence],
              )
            ).rowCount
          )
            fail(409, "Source sequence already occupied");
          const previous = (
            await tx.query(
              "SELECT COALESCE(max(sequence),0) AS n FROM events WHERE session_id=$1 AND source_id=$2",
              [sid, e.sourceId],
            )
          ).rows[0].n;
          await tx.query(
            "INSERT INTO events(id,session_id,event_id,source_id,sequence,source_time,late,original,content_digest,tool,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              randomUUID(),
              sid,
              e.eventId,
              e.sourceId,
              e.sequence,
              e.sourceTime,
              e.sequence < previous,
              JSON.stringify(e),
              d,
              typeof e.raw.tool === "string" ? e.raw.tool.slice(0, 160) : null,
              typeof e.raw.outcome === "string"
                ? e.raw.outcome.slice(0, 160)
                : null,
            ],
          );
          accepted++;
        }
        await audit(tx, `client:${req.clientId}`, "events.ingested", sid, {
          accepted,
          duplicates,
        });
        return { accepted, duplicates, verification: "not verified" };
      });
      res.json(result);
    } catch (error) {
      await transaction(pool, async (tx) => {
        await tx.query(
          "UPDATE clients SET ingestion_errors=ingestion_errors+1,last_error=$2 WHERE id=$1",
          [
            req.clientId,
            error instanceof Problem ? error.message : "Invalid event batch",
          ],
        );
        await audit(
          tx,
          `client:${req.clientId}`,
          "events.rejected",
          String(req.params.id).slice(0, 100),
        );
      });
      throw error;
    }
  });
  app.post("/api/client/requests", async (req, res) => {
    const data = requestSchema.parse(req.body),
      d = digest(data);
    const result = await transaction(pool, async (tx) => {
      const head = (
        await tx.query("SELECT version_id FROM policy_head FOR UPDATE")
      ).rows[0];
      await clientLock(tx, req.clientId!);
      await expire(tx);
      const existing = (
        await tx.query(
          "SELECT * FROM execution_requests WHERE client_id=$1 AND operation_id=$2",
          [req.clientId, data.operationId],
        )
      ).rows[0];
      if (existing) {
        if (existing.digest !== d)
          fail(409, "Operation ID reused with different input");
        return existing;
      }
      const s = await ownedSession(tx, data.sessionId, req.clientId!);
      if (s.status !== "active") fail(409, "Session is completed");
      const policy = (
        await tx.query("SELECT * FROM policy_versions WHERE id=$1", [
          head.version_id,
        ])
      ).rows[0];
      const evaluation = evaluate(policy.rules, data);
      const state =
        evaluation.action === "deny"
          ? "denied"
          : evaluation.action === "permit"
            ? "approved"
            : "pending";
      const r = (
        await tx.query(
          `INSERT INTO execution_requests(id,client_id,session_id,operation_id,payload,digest,policy_version,matched_rules,evaluation,state,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11*interval '1 second') RETURNING *`,
          [
            randomUUID(),
            req.clientId,
            data.sessionId,
            data.operationId,
            JSON.stringify(data),
            d,
            policy.id,
            JSON.stringify(evaluation.matches),
            evaluation.action,
            state,
            data.ttlSeconds,
          ],
        )
      ).rows[0];
      await audit(tx, `client:${req.clientId}`, "request.evaluated", r.id, {
        policyVersion: policy.id,
        action: evaluation.action,
        digest: d,
      });
      return r;
    });
    res.json(publicRequest(result));
  });
  app.get("/api/client/requests/:id", async (req, res) => {
    const r = await transaction(pool, async (tx) => {
      await expire(tx);
      return ownedRequest(tx, paramId(req), req.clientId!);
    });
    res.json(publicRequest(r));
  });
  app.post("/api/client/requests/:id/cancel", async (req, res) => {
    const r = await transaction(pool, async (tx) => {
      await clientLock(tx, req.clientId!);
      await expire(tx);
      const r = await ownedRequest(tx, paramId(req), req.clientId!);
      if (!["pending", "approved"].includes(r.state) || r.claimed_at)
        fail(409, "Request cannot be cancelled");
      await tx.query(
        "UPDATE execution_requests SET state='cancelled',cancellation_reason='Client cancelled' WHERE id=$1",
        [r.id],
      );
      await audit(tx, `client:${req.clientId}`, "request.cancelled", r.id);
      return { ...r, state: "cancelled" };
    });
    res.json(publicRequest(r));
  });
  app.post("/api/client/requests/:id/claim", async (req, res) => {
    const body = z
      .object({ digest: z.string().length(64) })
      .strict()
      .parse(req.body);
    const result = await transaction(pool, async (tx) => {
      await clientLock(tx, req.clientId!);
      await expire(tx);
      const r = await ownedRequest(tx, paramId(req), req.clientId!);
      if (r.digest !== body.digest) fail(409, "Request digest mismatch");
      if (r.state !== "approved" || r.claimed_at)
        fail(409, "Authorization unavailable or already claimed");
      const token = secret();
      const claimed = await tx.query(
        "UPDATE execution_requests SET claimed_at=clock_timestamp(),claim_hash=$2 WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",
        [r.id, hash(token)],
      );
      if (!claimed.rowCount) fail(409, "Authorization expired");
      await audit(tx, `client:${req.clientId}`, "authorization.claimed", r.id, {
        digest: r.digest,
      });
      return { claimToken: token, digest: r.digest, simulatedOnly: true };
    });
    res.json(result);
  });
  app.post("/api/client/requests/:id/report", async (req, res) => {
    const data = z
      .object({
        claimToken: z.string().min(40).max(100),
        simulated: z.literal(true),
        outcome: z.enum(["succeeded", "failed"]),
        details: z.string().max(4000),
      })
      .strict()
      .parse(req.body);
    const report = {
      simulated: data.simulated,
      outcome: data.outcome,
      details: data.details,
    };
    const result = await transaction(pool, async (tx) => {
      await clientLock(tx, req.clientId!);
      const r = await ownedRequest(tx, paramId(req), req.clientId!);
      if (!r.claimed_at || r.claim_hash !== hash(data.claimToken))
        fail(403, "Valid claim required");
      const existing = (
        await tx.query("SELECT * FROM execution_reports WHERE request_id=$1", [
          r.id,
        ])
      ).rows[0];
      if (existing) {
        if (existing.digest !== digest(report))
          fail(409, "Report is immutable");
        return existing;
      }
      const saved = (
        await tx.query(
          "INSERT INTO execution_reports(id,request_id,simulated,outcome,details,digest) VALUES($1,$2,true,$3,$4,$5) RETURNING *",
          [randomUUID(), r.id, data.outcome, data.details, digest(report)],
        )
      ).rows[0];
      await audit(tx, `client:${req.clientId}`, "simulation.reported", r.id, {
        outcome: data.outcome,
      });
      return saved;
    });
    res.json(result);
  });
  // No bearer credentials can reach browser/reviewer endpoints.
  app.use("/api", async (req, _res, next) => {
    if (!req.session.userId) return fail(401, "Sign in required");
    const user = (
      await pool.query("SELECT id,email,role FROM users WHERE id=$1", [
        req.session.userId,
      ])
    ).rows[0];
    if (!user) return fail(401, "Sign in required");
    if (!csrfSafe(req) && req.headers["x-csrf-token"] !== req.session.csrf)
      return fail(403, "CSRF token required");
    req.user = user;
    next();
  });
  app.get("/api/me", (req, res) =>
    res.json({ user: req.user, csrf: req.session.csrf }),
  );
  app.post("/api/logout", async (req, res) => {
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    res.clearCookie("testigo.sid", {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secure,
    });
    res.json({ ok: true });
  });
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.role !== "admin") return fail(403, "Administrator required");
    next();
  };
  app.get("/api/clients", async (_req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT id,name,created_at,revoked_at,last_contact,ingestion_errors,last_error FROM clients ORDER BY created_at DESC LIMIT 500",
        )
      ).rows,
    ),
  );
  app.post("/api/clients", admin, async (req, res) => {
    const { name } = z
      .object({ name: z.string().min(1).max(160) })
      .strict()
      .parse(req.body);
    const token = secret();
    const clientId = randomUUID();
    await transaction(pool, async (tx) => {
      await tx.query(
        "INSERT INTO clients(id,name,token_hash) VALUES($1,$2,$3)",
        [clientId, name, hash(token)],
      );
      await audit(tx, req.user!.email, "client.enrolled", clientId, { name });
    });
    res.status(201).json({ id: clientId, name, token });
  });
  app.post("/api/clients/:id/revoke", admin, async (req, res) => {
    await transaction(pool, async (tx) => {
      const c = (
        await tx.query("SELECT * FROM clients WHERE id=$1 FOR UPDATE", [
          paramId(req),
        ])
      ).rows[0];
      if (!c) fail(404, "Client not found");
      if (c.revoked_at) return;
      await tx.query("UPDATE clients SET revoked_at=now() WHERE id=$1", [c.id]);
      const rows = (
        await tx.query(
          "UPDATE execution_requests SET state='cancelled',cancellation_reason='Client revoked' WHERE client_id=$1 AND state IN ('pending','approved') AND claimed_at IS NULL RETURNING id",
          [c.id],
        )
      ).rows;
      for (const r of rows)
        await audit(tx, req.user!.email, "request.cancelled", r.id, {
          reason: "Client revoked",
        });
      await audit(tx, req.user!.email, "client.revoked", c.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/sessions", async (req, res) => {
    const q = z
      .object({
        client: id.optional(),
        caseRef: z.string().max(160).optional(),
      })
      .parse(req.query);
    res.json(
      (
        await pool.query(
          `SELECT s.*,c.name client_name FROM sessions s JOIN clients c ON c.id=s.client_id
    WHERE ($1::uuid IS NULL OR s.client_id=$1) AND ($2::text IS NULL OR s.case_ref=$2) ORDER BY s.created_at DESC LIMIT 500`,
          [q.client ?? null, q.caseRef ?? null],
        )
      ).rows,
    );
  });
  app.get("/api/sessions/:id/events", async (req, res) => {
    const q = z
      .object({
        tool: z.string().max(160).optional(),
        outcome: z.string().max(160).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    const sid = paramId(req);
    const rows = (
      await pool.query(
        `SELECT * FROM events WHERE session_id=$1 AND ($2::text IS NULL OR tool=$2) AND ($3::text IS NULL OR outcome=$3)
   AND ($4::timestamptz IS NULL OR source_time >= $4) AND ($5::timestamptz IS NULL OR source_time <= $5)
   ORDER BY source_time,source_id,sequence LIMIT 201 OFFSET $6`,
        [
          sid,
          q.tool ?? null,
          q.outcome ?? null,
          q.from ?? null,
          q.to ?? null,
          q.offset,
        ],
      )
    ).rows;
    const gaps = (
      await pool.query(
        `WITH ordered AS (SELECT source_id, sequence, lag(sequence,1,0) OVER(PARTITION BY source_id ORDER BY sequence) previous FROM events WHERE session_id=$1)
   SELECT source_id,previous+1 AS missing_from,sequence-1 AS missing_to FROM ordered WHERE sequence>previous+1 ORDER BY source_id,previous LIMIT 101`,
        [sid],
      )
    ).rows;
    const sources = (
      await pool.query(
        "SELECT source_id,min(sequence) first_sequence,max(sequence) last_sequence,count(*) received FROM events WHERE session_id=$1 GROUP BY source_id ORDER BY source_id",
        [sid],
      )
    ).rows;
    res.json({
      events: rows.slice(0, 200),
      hasMore: rows.length > 200,
      gaps: gaps.slice(0, 100),
      moreGaps: gaps.length > 100,
      sources,
      verification: "not verified",
    });
  });
  app.get("/api/requests", async (req, res) => {
    const q = z
      .object({
        state: z
          .enum(["pending", "approved", "denied", "expired", "cancelled"])
          .optional(),
        session: id.optional(),
      })
      .parse(req.query);
    const rows = await transaction(pool, async (tx) => {
      await expire(tx);
      return (
        await tx.query(
          `SELECT r.*,c.name client_name,s.title session_title,
   CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('reviewer',u.email,'reason',d.reason,'decision',d.decision,'decided_at',d.decided_at) END decision,
   CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object('simulated',e.simulated,'outcome',e.outcome,'details',e.details,'reported_at',e.reported_at) END report
   FROM execution_requests r JOIN clients c ON r.client_id=c.id JOIN sessions s ON s.id=r.session_id
   LEFT JOIN approval_decisions d ON d.request_id=r.id LEFT JOIN users u ON u.id=d.reviewer_id LEFT JOIN execution_reports e ON e.request_id=r.id
   WHERE ($1::text IS NULL OR r.state=$1) AND ($2::uuid IS NULL OR r.session_id=$2) ORDER BY r.created_at DESC LIMIT 500`,
          [q.state ?? null, q.session ?? null],
        )
      ).rows;
    });
    res.json(rows.map(publicRequest));
  });
  app.post("/api/requests/:id/decision", async (req, res) => {
    const body = z
      .object({
        decision: z.enum(["approved", "denied"]),
        reason: z.string().max(2000).default(""),
        digest: z.string().length(64),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(pool, async (tx) => {
      await tx.query("SELECT version_id FROM policy_head FOR UPDATE");
      await expire(tx);
      const r = (
        await tx.query(
          "SELECT * FROM execution_requests WHERE id=$1 FOR UPDATE",
          [paramId(req)],
        )
      ).rows[0];
      if (!r) fail(404, "Request not found");
      if (r.digest !== body.digest) fail(409, "Request digest mismatch");
      if (r.state !== "pending") fail(409, "Request no longer pending");
      const changed = await tx.query(
        "UPDATE execution_requests SET state=$2 WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",
        [r.id, body.decision],
      );
      if (!changed.rowCount) fail(409, "Request expired");
      await tx.query(
        "INSERT INTO approval_decisions(id,request_id,reviewer_id,decision,reason) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), r.id, req.user!.id, body.decision, body.reason],
      );
      await audit(tx, req.user!.email, `request.${body.decision}`, r.id, {
        reason: body.reason,
        digest: r.digest,
      });
      return { ...r, state: body.decision };
    });
    res.json(publicRequest(result));
  });
  app.get("/api/policy", async (_req, res) => {
    res.json(
      (
        await pool.query(
          "SELECT p.* FROM policy_versions p JOIN policy_head h ON p.id=h.version_id",
        )
      ).rows[0],
    );
  });
  app.get("/api/policy/history", async (_req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT * FROM policy_versions ORDER BY id DESC LIMIT 100",
        )
      ).rows,
    ),
  );
  app.put("/api/policy", admin, async (req, res) => {
    const data = policySchema.parse(req.body);
    const result = await transaction(pool, async (tx) => {
      const head = (
        await tx.query("SELECT version_id FROM policy_head FOR UPDATE")
      ).rows[0];
      if (head.version_id !== data.baseVersion)
        fail(409, "Policy changed; reload before saving");
      const p = (
        await tx.query(
          "INSERT INTO policy_versions(rules,created_by) VALUES($1,$2) RETURNING *",
          [JSON.stringify(data.rules), req.user!.id],
        )
      ).rows[0];
      await tx.query("UPDATE policy_head SET version_id=$1", [p.id]);
      const cancelled = (
        await tx.query(
          "UPDATE execution_requests SET state='cancelled',cancellation_reason='Policy changed; resubmit with a new operation ID' WHERE state='pending' RETURNING id",
        )
      ).rows;
      for (const r of cancelled)
        await audit(tx, req.user!.email, "request.invalidated", r.id, {
          policyVersion: p.id,
        });
      await audit(tx, req.user!.email, "policy.published", String(p.id), {
        invalidated: cancelled.length,
      });
      return p;
    });
    res.json(result);
  });
  app.get("/api/audit", async (req, res) => {
    const q = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    res.json(
      (
        await pool.query(
          "SELECT * FROM audit_entries WHERE ($1::bigint IS NULL OR id<$1) ORDER BY id DESC LIMIT 200",
          [q.before ?? null],
        )
      ).rows,
    );
  });
  app.use("/api", (_req, _res) => fail(404, "Endpoint not found"));
  app.use(express.static(fileURLToPath(new URL("../dist", import.meta.url))));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: "Invalid input",
          issues: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
      if (error instanceof Problem)
        return res.status(error.status).json({ error: error.message });
      if ((error as { type?: string }).type === "entity.too.large")
        return res.status(413).json({ error: "Body exceeds 256 KiB" });
      if (error instanceof SyntaxError)
        return res.status(400).json({ error: "Invalid JSON" });
      // Deliberately exclude submitted data, credentials, and database query values.
      console.error(
        "Request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      res.status(500).json({ error: "Internal error" });
    },
  );
  return app;
}
