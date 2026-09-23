# Testigo Server: implementation plan for the first POC

Date: 2026-09-22
Status: agreed direction; implementation delegated to a separate Astra task.

## Objective and boundaries

Build a runnable single-company server and dashboard demonstrating central session auditing, server-side policy evaluation, and remote human approvals. Use a standalone simulated client to exercise the API. Do not edit, install, configure, or otherwise change the Claude Code plugin, its hooks, the existing CLI, or the Testigo protocol.

The first audience is developers using Claude Code. This POC demonstrates server behavior, not real interception or enforcement in Claude Code. No production resources, customer data, corporate deployment, GitHub publication, or new MCP tools. Carlos Manuel owns separating the existing projects and moving them to the company account.

Work in an isolated checkout of the Testigo project. Put the implementation in a self-contained `server-poc/` directory, easy to move to its own repository later. Leave existing project files intact. Use `feature/` for any explicitly created branch; never commit on a `codex/` branch. No commit or publication is required. GitHub mutations, if later authorized, must use verified account `fredyalmenares`, never `sbarrerautu`.

## Proposed implementation

Use TypeScript, a Node HTTP API, React with Vite, and PostgreSQL with migrations. Prefer a small conventional stack and reuse suitable existing dependencies only when that does not couple the server to the plugin. Pin versions and document runtime requirements. Provide Docker Compose for PostgreSQL and, if feasible, the full application. No Kafka, Redis, vector database, natural-language chatbot, or multi-company SaaS infrastructure.

Keep API types and client-facing protocol separate from UI components. Document endpoints and provide reproducible example requests. Clearly distinguish the new server API from the existing Testigo evidence protocol.

## Milestone 1: persistence, identities, and ingestion

- Model users, registered clients, sessions, events, policy versions, execution requests, approval decisions, and audit entries.
- Support administrator and reviewer roles. Administrators manage policies and enroll/revoke clients; authorized reviewers view sessions and decide requests. Bootstrap accounts explicitly, without shipped passwords. Use a standard password-hashing/session implementation, protected cookies, and CSRF/origin checks for browser mutations. Do not store browser admin credentials in localStorage.
- Issue distinct revocable client credentials. Store only their hashes, show secrets only upon issuance, and bind sessions/requests to the authenticated client. A client must not choose another client's identity or read its records. A registered device identity is not proof of which human physically acted.
- Receive bounded event batches with stable event IDs and idempotent retries. Retain source identifiers and server receive times, distinguish late arrivals from source order, and surface gaps where sequence information is available. Keep original event data separate from search projections; do not merge independent source chains or rewrite hashes.
- Preserve relevant Testigo event fields and provenance. Where verification is unsupported, display `not verified`; do not invent a compatible signature or claim full Testigo verification. Do not upload private signing keys.
- Track latest client contact, active/completed sessions, and ingestion errors. Recent contact does not imply complete capture.

## Milestone 2: central policy evaluation

- Evaluate rules only on the server. Clients submit a tool name, structured arguments, working directory where available, session ID, and a stable operation/idempotency ID. Environment labels supplied by clients are descriptive, not independently trusted facts.
- Decision vocabulary: permitted by Testigo, denied, or pending human approval. A Testigo permission never means overriding native Claude permissions.
- First coverage: Bash and PowerShell requests. Provide a small versioned rule editor with enabled state, tool match, simple bounded command matching, and action. Document exact matching semantics and precedence: any matching deny wins; otherwise approval wins over permit; unmatched shell requests require approval.
- Use plain literal/prefix matchers with boundary checks rather than unbounded user-supplied regex. These are demonstration rules, not a shell security parser. Explicitly explain that scripts, aliases, quoting, and compound commands limit their coverage. Do not label arbitrary shell commands safe because a substring looks harmless.
- Seed a reviewable demonstration policy: exact `git status` permitted, a documented `git push` pattern requires approval, and a synthetic destructive-command example denied. Seed data must never execute these commands.
- Every evaluation records the matched rule and immutable policy version. Policy updates apply to new evaluations; invalidate undecided requests under an older version and require resubmission, rather than quietly applying different rules to the same pending request.

## Milestone 3: approvals and request lifecycle

- Persist pending, approved, denied, expired, and cancelled states; record execution reports separately from authorization. An approval is not evidence of successful execution.
- Bind an approval to a server-computed digest of the immutable tool name, arguments, session, and relevant context. Reject a repeated operation ID with a different payload. A changed request requires a new request and approval.
- Reviewer sees exact proposed input, session/client identity, matched policy, creation time, expiry, and any bounded supporting context. Treat all submitted text as untrusted and render without executable HTML.
- Provide approve/deny with an optional reason, status polling, expiry, and a single-use authorization claim endpoint. Make decision and claim transitions transactional so concurrent reviewers or retries cannot authorize multiple executions. Expiry is enforced when reading/claiming, even without a background cleanup job.
- An approval must not grant a session-wide or permanent tool permission. The simulator can claim an authorization and report a simulated result; label that result as simulated. Do not claim exactly-once execution merely because claims are single-use.
- Record who decided, when, and why. Decisions cannot be silently edited. Clients cannot approve themselves or invoke reviewer endpoints.

## Milestone 4: usable dashboard and simulation

Build a compact English UI with:

1. Registered clients and recent connectivity.
2. Session list and chronological event detail, filterable by client, session, tool, time, and outcome.
3. Pending approvals with enough context to decide; show terminal states and expiry clearly.
4. Restricted policy management and audit history.

Use periodic polling for the POC; SSE is optional if it stays simple. A simulated client should register or use a provisioned credential, create two sessions, submit synthetic events, request a `git push`, wait for a dashboard decision, claim approval, and report a simulated result. It must never execute submitted shell commands. Clearly distinguish fixtures from real sessions.

Support linking sessions by an explicit shared case/ticket reference. Do not infer causality merely from timestamps or claim to know who changed a database without external evidence. Advanced cross-session investigation is deferred.

## Security and privacy boundaries

- Bind the default development server to localhost. Document HTTPS as required for a remote deployment; do not pretend plain HTTP is encrypted. Do not deploy externally in this task.
- Use only synthetic data in fixtures. Bound requests and stored text, avoid logging credentials or full request bodies, validate inputs, and restrict cross-origin access.
- Document allowed data, retention, backup/access assumptions, and known limitations. A configurable retention cleanup should not destroy integrity-critical source data silently or leave misleading verification badges.
- The future plugin must minimize/redact data before sending; this task does not implement that change. Server filtering cannot undo disclosure of an already received secret.
- This service is not a compliance certification or a tamper-proof corporate archive. No guarantee that a local hook cannot be disabled. Offline behavior, hook timeouts, and Claude integration remain future work.

## Required validation and acceptance criteria

Use meaningful API/database integration tests for authorization boundaries, policy precedence, unmatched shell requests, policy invalidation, immutable request binding, idempotency, duplicate/conflicting events, expiry, concurrent decisions, single-use claims, and client isolation. Test unsafe HTML rendering in event/request details. Test the UI flow through a browser where available, otherwise explicitly report what was not verified.

The runnable demo must show: permitted request, denied request, dashboard approval, human rejection, expired request, repeated submission without duplication, and a simulated completion recorded separately from approval. Verify application restart preserves sessions and pending requests. Build/type checks must pass. Do not report database or browser tests as passed if unavailable.

Deliver source, lockfile, migrations, `.env.example` without secrets, setup/run instructions, simulator instructions, API documentation, test results, and limitations. Provide the exact commands and a short walkthrough for the user. Start the local demo when practical and show its URL; do not expose it publicly.

## Later, explicitly outside this task

Claude plugin integration; hardened enforcement at execution boundaries; Codex adapter; corporate SSO; production deployment; external Git/CI/database evidence; natural-language investigation; multi-company isolation; formal compliance work.
