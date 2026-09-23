import { z } from "zod";
export const id = z.string().uuid();
const label = z.string().min(1).max(160);
export const ruleSchema = z
  .object({
    id: label,
    enabled: z.boolean(),
    tool: z.enum(["Bash", "PowerShell", "*"]),
    matcher: z.enum(["exact", "prefix"]),
    value: z.string().min(1).max(300),
    action: z.enum(["permit", "approval", "deny"]),
  })
  .strict()
  .refine(
    (r) => !(r.matcher === "prefix" && r.action === "permit"),
    "Permit rules must be exact",
  );
export const policySchema = z
  .object({
    baseVersion: z.number().int().positive(),
    rules: z.array(ruleSchema).min(1).max(50),
  })
  .strict()
  .refine(
    (p) => new Set(p.rules.map((r) => r.id)).size === p.rules.length,
    "Rule IDs must be unique",
  );
export type Rule = z.infer<typeof ruleSchema>;
export const requestSchema = z
  .object({
    operationId: label,
    sessionId: id,
    tool: z.enum(["Bash", "PowerShell"]),
    arguments: z
      .object({ command: z.string().min(1).max(8000) })
      .catchall(z.json()),
    cwd: z.string().max(1000).default(""),
    environment: z.string().max(100).default(""),
    context: z.string().max(4000).default(""),
    ttlSeconds: z.number().int().min(1).max(3600).default(600),
  })
  .strict()
  .refine(
    (v) => JSON.stringify(v.arguments).length <= 12000,
    "Arguments exceed limit",
  );
export type ExecutionInput = z.infer<typeof requestSchema>;
export const sessionSchema = z
  .object({
    sourceId: label,
    title: label,
    caseRef: z.string().max(160).default(""),
    fixture: z.boolean(),
  })
  .strict();
export const eventSchema = z
  .object({
    eventId: label,
    sourceId: label,
    sequence: z.number().int().min(1).max(1000000),
    sourceTime: z.iso.datetime({ offset: true }),
    raw: z.record(z.string(), z.json()),
  })
  .strict()
  .refine((e) => JSON.stringify(e.raw).length <= 16000, "Event exceeds limit");
export const eventsSchema = z
  .object({ events: z.array(eventSchema).min(1).max(50) })
  .strict();
export type EventInput = z.infer<typeof eventSchema>;
export type RequestState =
  "pending" | "approved" | "denied" | "expired" | "cancelled";
export interface RequestRecord {
  id: string;
  client_id: string;
  session_id: string;
  operation_id: string;
  payload: ExecutionInput;
  digest: string;
  policy_version: number;
  matched_rules: string[];
  evaluation: "permit" | "approval" | "deny";
  state: RequestState;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  client_name?: string;
  session_title?: string;
  cancellation_reason?: string;
  decision?: {
    reviewer: string;
    reason: string;
    decision: string;
    decided_at: string;
  } | null;
  report?: {
    simulated: true;
    outcome: string;
    details: string;
    reported_at: string;
  } | null;
}
export interface SessionRecord {
  id: string;
  client_id: string;
  client_name: string;
  title: string;
  source_id: string;
  case_ref: string;
  fixture: boolean;
  status: string;
  created_at: string;
}
export interface ClientRecord {
  id: string;
  name: string;
  revoked_at: string | null;
  last_contact: string | null;
  ingestion_errors: number;
  last_error: string | null;
}
export interface EventRecord {
  id: string;
  event_id: string;
  source_id: string;
  sequence: number;
  source_time: string;
  received_at: string;
  late: boolean;
  tool: string | null;
  outcome: string | null;
  original: EventInput;
}
export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
  created_at: string;
}
