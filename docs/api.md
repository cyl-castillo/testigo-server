# Standalone server API v0.1

This HTTP API is new and deliberately separate from the existing Testigo evidence protocol. Base URL: `http://127.0.0.1:4310/api`. JSON only. Errors use `{ "error": "…", "issues": […] }`; issues appear for validation failures. Expected statuses: 400 invalid input, 401 missing/invalid identity, 403 role/origin/CSRF/claim violation, 404 inaccessible or missing record, 409 state/identity conflict, 413 payload too large, 429 login rate limit.

## Browser identity

`POST /login` accepts `{email,password}` and returns `{user:{id,email,role},csrf}` with an opaque, signed `testigo.sid` cookie. The cookie is HttpOnly, SameSite=Strict, eight hours; its data is stored in PostgreSQL using `express-session` and `connect-pg-simple`. Login regenerates the session ID. `GET /me` returns current identity and the CSRF token. `POST /logout` destroys the stored session and clears the cookie. Credentials are never stored in localStorage.

Every browser mutation, including login, requires `Origin` exactly equal to `APP_ORIGIN`. Authenticated browser mutations also require `X-CSRF-Token`. Client bearer credentials do not authenticate a browser/reviewer route. The administrator has reviewer privileges; reviewers cannot enroll/revoke clients or publish policies. Anyone with local database-owner access can explicitly bootstrap accounts with the documented CLI.

| Method / path | Role | Behavior |
|---|---|---|
| GET `/health` | Public | Database liveness, POC label and `not verified` |
| GET `/clients` | Reviewer/admin | Up to 500 clients; never returns token hashes or credentials |
| POST `/clients` | Admin | `{name}`; returns `{id,name,token}` once |
| POST `/clients/:id/revoke` | Admin | Revokes credential and cancels unclaimed pending/approved requests |
| GET `/sessions?client=UUID&caseRef=TEXT` | Reviewer/admin | Most recent 500 sessions; exact optional filters |
| GET `/sessions/:id/events` | Reviewer/admin | Chronological source-time page, independent-source health and observed sequence gaps |
| GET `/requests?state=pending&session=UUID` | Reviewer/admin | Most recent 500 requests; optional exact filters; decision and report returned separately |
| POST `/requests/:id/decision` | Reviewer/admin | `{decision:"approved"\|"denied",digest,reason?}`; one immutable decision |
| GET `/policy` | Reviewer/admin | Current immutable version and rules |
| GET `/policy/history` | Reviewer/admin | Most recent 100 versions |
| PUT `/policy` | Admin | `{baseVersion,rules}`; optimistic version check; invalidates pending requests transactionally |
| GET `/audit?before=ID` | Reviewer/admin | 200 entries per page, newest first, cursor by audit ID |

Event filters: `tool`, `outcome` (exact case-sensitive projection strings), `from`, `to` (inclusive ISO-8601 source-time bounds), `offset` (default 0). Response: `{events,hasMore,gaps,moreGaps,sources,verification:"not verified"}`. Page size 200; first 100 gap ranges. Gaps and source counts are computed for the whole selected session, regardless of event filters. No dashboard total claims to cover records beyond the documented 500-record listing window.

## Client identity

All `/client/*` routes require `Authorization: Bearer CLIENT_TOKEN`. Tokens contain 256 random bits; only SHA-256 hashes are stored. Enrollment returns a token once. Revocation is checked again under a database row lock for writes. Client IDs are derived from the credential, never accepted in submitted bodies. Other clients' resources return 404. Cookie authentication cannot substitute for a client credential.

| Method / path | Body / result |
|---|---|
| POST `/client/sessions` | `{sourceId,title,caseRef?,fixture}` → session. Same client/sourceId + identical input returns the same record; changed input is 409. |
| GET `/client/sessions/:id` | Own session only. |
| POST `/client/sessions/:id/complete` | `{}` → completed. Cancels outstanding unclaimed requests; late event uploads are still allowed. |
| POST `/client/sessions/:id/events` | `{events:[Event,…]}` → `{accepted,duplicates,verification}`. Atomic batch. |
| POST `/client/requests` | Execution input → immutable evaluation / request. |
| GET `/client/requests/:id` | Own status; expiry enforced during read. |
| POST `/client/requests/:id/cancel` | `{}` → cancelled when pending or approved but unclaimed. |
| POST `/client/requests/:id/claim` | `{digest}` → `{claimToken,digest,simulatedOnly:true}` once. |
| POST `/client/requests/:id/report` | `{claimToken,simulated:true,outcome:"succeeded"\|"failed",details}` → immutable simulated report. |

An event envelope is:

```json
{
  "eventId": "source-stable-event-1",
  "sourceId": "independent-chain-a",
  "sequence": 1,
  "sourceTime": "2026-09-22T12:00:00Z",
  "raw": {
    "tool": "Bash",
    "outcome": "observed",
    "message": "Synthetic observation",
    "source_hash": "retain-original-source-value",
    "signature": "unsupported synthetic fixture"
  }
}
```

Sequence starts at 1, is an integer up to 1,000,000 and is unique **within a session/source chain**. Event IDs are also unique within that pair. A duplicate event with identical parsed JSON is idempotent; any changed content or occupied sequence with another ID rejects the entire batch. Each independent source chain remains separate. Source timestamps do not determine sequence order. `late` means sequence was below the largest already received sequence at insertion. Gaps include missing numbers before the first observation and between received observations; an unknown missing tail cannot be detected.

`original` retains the submitted parsed envelope and raw fields as JSONB, separate from tool/outcome search projections, receive time and the server content digest. JSON whitespace/key ordering are not preserved. Existing hash/signature fields are never recomputed, merged or labelled valid. This is not native protocol verification and is not a byte-exact signed evidence archive. Never include signing private keys.

Execution input:

```json
{
  "operationId": "stable-push-operation-1",
  "sessionId": "SERVER_SESSION_UUID",
  "tool": "Bash",
  "arguments": {"command": "git push origin demo"},
  "cwd": "/synthetic/workspace",
  "environment": "demo (client supplied)",
  "context": "Synthetic release review; no command will be executed.",
  "ttlSeconds": 600
}
```

Only `Bash` and `PowerShell` are supported. Additional structured argument keys are retained and digest-bound; the rule engine only examines `arguments.command`. All supplied context, including environment, is descriptive and unverified. Unknown top-level fields are rejected. Maximum JSON body: 256 KiB; events/batch: 50; raw event: 16,000 characters of serialized JSON; command: 8,000; arguments: 12,000 serialized characters; context: 4,000; labels: 160; expiry: 1–3,600 seconds, default 600. Payloads with NUL or nesting deeper than 20 levels are rejected before schema validation.

SHA-256 over recursively key-sorted canonical JSON of the validated, default-filled execution input binds the operation ID, session, tool, all arguments, cwd, environment, context and TTL. JSON array order is significant; object key order is not. Repeating an operation ID for the same client returns the existing record including its current terminal state. Any change to its bound input returns 409. A new request needs a new operation ID.

### Evaluation and authorization semantics

- Exact matching is case-sensitive string equality, with **no trimming, quoting normalization or shell parsing**. Seeded exact `git status` is permitted by Testigo.
- Prefix matching requires equality or a prefix followed by one JavaScript whitespace character or one of `; & | < >`. `git push origin demo` and `git push;…` match the review rule; `git pushy` does not. Prefix permits are rejected, so broad permit rules cannot accidentally classify compounds by prefix.
- Enabled rules match the exact tool name or `*`. Any matching deny wins; otherwise any approval wins; otherwise a matching permit wins. Unmatched requests require approval. All matched rule IDs and the immutable policy version are stored.
- Seeded `testigo-demo destroy …` is a **synthetic** denied example, never executed. These demonstration rules are not a shell security parser. Aliases, scripts and shell interpretation can defeat assumptions about what a command does.
- Response `evaluation` is `permit`, `deny` or `approval`. Display vocabulary: **permitted by Testigo**, **denied**, **pending human approval**. Request lifecycle `state` is separately `pending`, `approved`, `denied`, `expired`, or `cancelled`. A policy permit starts in `approved` with no human decision record.
- Publication obtains the same head-row lock as evaluation/decision, creates a new version and cancels all undecided requests. Already decided requests retain their original policy binding; approved, unclaimed requests can still be claimed until expiry unless client/session revocation cancels them.
- Decisions, claims, revocation and retries use transactions/row locks. A second decision or claim returns 409. A claim never grants a tool-wide or session-wide permission. Claims are not reissued after a lost response. The caller must treat a lost response as uncertain, not request another execution.
- Expiry is checked by reads, dashboard polling, review and claims; no scheduler is required. An approved but unclaimed authorization expires. A claimed authorization is historical and its report may arrive after expiry. Reports require the one-time claim secret and are idempotent only when identical.
- A single-use claim is **not exactly-once execution**. Nothing in this POC intercepts a shell or proves a command ran. Reports must explicitly set `simulated:true`. Native Claude permissions remain independent.

## Reproducible PowerShell client requests

With the local database/server running and the setup-provisioned client:

```powershell
$base = 'http://127.0.0.1:4310/api'
$clientToken = (Get-Content -Raw .local/client-token).Trim()
$headers = @{ Authorization = "Bearer $clientToken" }
$sessionInput = @{ sourceId = [guid]::NewGuid().ToString(); title = 'API fixture'; fixture = $true; caseRef = 'DEMO-API' }
$session = Invoke-RestMethod "$base/client/sessions" -Method Post -Headers $headers -ContentType 'application/json' -Body ($sessionInput | ConvertTo-Json)
$inputData = @{ operationId = [guid]::NewGuid().ToString(); sessionId = $session.id; tool = 'Bash'; arguments = @{command='git status'}; ttlSeconds=600 }
$request = Invoke-RestMethod "$base/client/requests" -Method Post -Headers $headers -ContentType 'application/json' -Body ($inputData | ConvertTo-Json -Depth 10)
# The same body returns the same request ID.
$retry = Invoke-RestMethod "$base/client/requests" -Method Post -Headers $headers -ContentType 'application/json' -Body ($inputData | ConvertTo-Json -Depth 10)
$claim = Invoke-RestMethod "$base/client/requests/$($request.id)/claim" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{digest=$request.digest} | ConvertTo-Json)
$report = @{claimToken=$claim.claimToken; simulated=$true; outcome='succeeded'; details='Simulation only; no shell execution'}
Invoke-RestMethod "$base/client/requests/$($request.id)/report" -Method Post -Headers $headers -ContentType 'application/json' -Body ($report | ConvertTo-Json)
```

The above sends strings to the API; it never invokes the proposed command. For human approvals, replace `git status` with `git push origin demo` and use the dashboard before claiming. Use a new operation ID when changing the payload. The complete two-session workflow is `npm run simulate`.
