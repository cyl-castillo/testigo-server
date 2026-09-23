# Security and operating boundaries

## What this POC demonstrates

This single-company service centralizes observations, evaluates demonstration rules on the server and records reviewer decisions. It does not enforce Claude permissions, change hooks or plugins, prevent a local user disabling capture, prove complete capture, or prove who physically used a registered workstation. All fixtures are synthetic. All source evidence displays **not verified**. It is neither a compliance certification nor a tamper-proof archive.

Shell commands submitted to the API are data. Neither the server nor simulator executes them. Scripts that launch the application or portable PostgreSQL do not execute submitted commands. The rule engine is bounded literal/prefix matching, not a shell security parser. Aliases, scripts, quoting, compound commands and runtime interpretation limit coverage. No arbitrary command is declared safe because a substring looks harmless.

## Identities and authorization

Passwords are salted with 256 random bits and derived through Node's standard scrypt implementation (N=16384, r=8, p=1, 64-byte output). Comparisons use constant-time equality. Login has an IP-based 15-attempt/15-minute limit; nonexistent accounts also perform password derivation. There are no shipped passwords. Accounts are explicitly created by a local operator. There is no self-registration, recovery email, MFA or SSO.

Browser sessions use `express-session` and `connect-pg-simple`: server-side PostgreSQL sessions, signed opaque ID cookie, regeneration on login, logout invalidation, eight-hour cookie, HttpOnly, SameSite=Strict. Secure cookies are required for remote origins. Session secrets must be random and at least 32 characters. CSRF tokens live in memory; browser mutations require both exact origin and the token. No browser password/token is kept in localStorage. Client tokens have 256 random bits and are stored only as SHA-256 hashes. The API returns new client secrets once and never lists them.

Administrators can enroll/revoke clients and publish policies. Reviewers and administrators can read the single company's data and make individual decisions. Clients cannot invoke reviewer functions or access other clients' records. Any authenticated reviewer can approve any pending request in this one-company POC; separation of duties, per-project approval permissions and reviewer assignment are deferred.

Revocation cancels pending and approved **unclaimed** requests. Session completion does the same. Neither can undo a claim already issued. All reports remain simulated. A claim response lost in transit is not replayable; single-use claiming does not prove exactly-once execution. A policy change invalidates pending requests, while previously decided requests remain bound to their original version. The caller must submit a new operation ID after invalidation.

## Storage and source provenance

Original parsed event envelopes, source identifiers, hash/signature fields, sequence numbers and timestamps remain separate from search projections and server-receive times. JSONB retains values, not byte-level formatting. Server digests provide request/idempotency binding; they are not signatures or native Testigo verification. Independent source chains are not stitched together. Missing ranges are explicitly surfaced where sequence information exists. Unknown missing tails and entirely unreported sessions are undetectable. A shared case reference is supplied explicitly, not inferred as causality.

Application writes use PostgreSQL transactions. Event, decision, report, policy and audit mutation protections are reinforced by database triggers; bound request fields cannot be rewritten. The database owner can bypass protections and read data. PostgreSQL credentials are for a dedicated local POC database. A production service needs independently managed application/migration roles, access controls, key management and external audit storage. Serial IDs may have gaps after rollback or crash recovery; they are identifiers, not evidence sequence numbers.

## Data policy and retention

Only synthetic, non-sensitive fixtures are allowed for this evaluation. Do not send private signing keys, passwords, access tokens, production source code, customer information or personal data. Payload size/depth limits and HTML escaping protect processing; they are **not secret redaction**. A future client must minimize/redact before transmission. Server filtering cannot undo an already received disclosure. Request/error logs omit credentials and submitted bodies. Authentication and fixture credential files are local secrets even in a synthetic demo.

`RETENTION_DAYS` defaults to 30. `npm run retention` only previews complete sessions older than the cutoff. It excludes sessions with pending/approved unclaimed requests and claimed requests lacking a report. There is no automatic deletion scheduler. `npm run retention -- --apply` explicitly deletes whole eligible sessions, their source events, request payloads, decisions and reports, in one transaction. It appends a lasting `session.purged` tombstone recording the session ID and removed-event count. It never leaves a partial source chain with a verification badge. Audits, users, clients and policy versions are retained; audit reasons can themselves contain sensitive data, which is why fixtures must be synthetic.

Purging is irreversible without a backup. Review the dry-run and export/back up the dedicated database first. Retention does not delete exported backups, external logs or the caller's copies. There is no claim of regulatory erasure. Database access is restricted operationally to the local operator; no production backup or encryption-at-rest system is installed. Use PostgreSQL `pg_dump` / `pg_restore` under your access and retention policy for real deployments, and verify restore independently. Backup/restore is not validated by this POC; database restart durability is.

## Network and deployment

Default API and portable PostgreSQL listeners bind `127.0.0.1`. Compose maps both services to loopback; the app's `0.0.0.0` applies only inside that container. No public hosting or tunnel is configured. Plain local HTTP is not encrypted. For any remote use, require HTTPS, `COOKIE_SECURE=true`, a correct `APP_ORIGIN`, restricted network access, an explicitly trusted reverse proxy, and separate secrets management. Set `TRUST_PROXY=true` only with exactly one trusted proxy and a backend inaccessible directly; otherwise leave it false. This task does not deploy or certify a remote installation.

Security headers include a same-origin Content Security Policy with no inline scripts or executable HTML. React renders all submitted strings as text. API responses are not cached. There is no permissive CORS configuration. Input bounds and parameterized queries constrain abuse, but the POC has no comprehensive per-client quotas, distributed rate limiting or production load validation. Listing windows (500 requests/sessions/clients) and polling are intentional small-demo limits.

## Deferred

Claude plugin integration, offline behavior and hook timeouts; hardened execution enforcement; real cryptographic protocol verification; user/device attribution; corporate SSO/MFA; production operations and security review; external Git/CI/database evidence; cross-session causal investigation; natural-language analysis; multi-company isolation; formal compliance work. The existing Testigo CLI, protocol and user settings remain untouched.

Portable runtime reference: [embedded-postgres upstream documentation](https://github.com/leinelissen/embedded-postgres). Package artifacts and dependencies are pinned by the npm lockfile; Docker image tags are versioned but not digest-pinned for production.
