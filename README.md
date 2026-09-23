# Testigo Server POC

A standalone, single-company server and English dashboard for synthetic session auditing, versioned policies and remote human decisions. **It does not intercept Claude Code, integrate with its plugin, or execute shell commands.** Everything lives in this directory and can be moved to a separate repository.

## Local demo (Windows, macOS or Linux)

Requirements: Node.js **22.16+**, npm 10+, a free application port **4310** and PostgreSQL ports **55432** (demo) / **55433** (tests). Run portable PostgreSQL as a normal user, not root. Versions are pinned in `package.json` and `package-lock.json`.

From this directory:

```powershell
npm ci
npm run setup
npm run build
```

`setup` explicitly provisions a fresh local PostgreSQL 17.10 database, an administrator and a synthetic client. Each installation generates independent random passwords and tokens. No password ships with the source. The portable PostgreSQL binaries come from the pinned `embedded-postgres` npm package, not a system installation. It creates no OS account or system service.

Open three terminals in this directory:

```powershell
# Terminal 1: keep the database running
npm run db
```

```powershell
# Terminal 2: serve API + compiled dashboard
npm start
```

```powershell
# Terminal 3: create fixtures and wait for decisions
npm run simulate
```

Open **http://127.0.0.1:4310**. Sign in with the generated credentials in `.local/access.txt`. Save the password and then remove that local plaintext file. Windows filesystem permissions are inherited: `mode: 0600` is not a replacement for Windows ACLs. `.env`, `.local/`, build output and dependencies are ignored by Git. Do not share or publish `.local` or `.env`.

Keep the exact host `127.0.0.1`; the allowed browser origin is intentionally strict. `localhost` is a different origin. HTTP is only a local demo transport and is not encrypted.

### Walkthrough

1. **Overview** shows client contact, sessions and pending requests. Fixture labels explicitly identify synthetic data.
2. In **Approvals**, approve `git push origin demo-approved` once and add a reason. Reject `git push origin demo-rejected` with a reason.
3. Select **All requests**. Inspect exact `git status` (permitted by Testigo), the synthetic destructive request (denied), the human decision records, and `demo-expired` (expired without a cleanup job).
4. The simulator claims each granted authorization once and writes a separate **simulated** result. Its repeat submission of `git status` returns the same request. It retries an identical event without duplicating it. It never spawns a shell to run submitted commands.
5. In **Sessions**, the two sessions share an explicit `DEMO-…` reference. Select the release session: sequence 2 arrived late, sequence 4 is missing, and original source data is inspectable. Recent contact and an absence of observed gaps do not prove complete capture.
6. **Policy** lets administrators edit and publish a version. All pending requests from the previous version are cancelled and must be resubmitted with new operation IDs. Existing decisions remain on record.
7. **Audit trail** records enrollment, ingestion, evaluations, decisions, claims and reports. Device identity is not proof of the human acting.

The simulator waits for up to one hour. Re-run it for a new, independently labelled case; it never deletes old fixtures. Requests expire after their original deadline. `.local/latest-simulation.json` identifies the latest run. `CLIENT_TOKEN` can provide a separately provisioned client credential instead of `.local/client-token`.

### Stop and restart

Use Ctrl+C in each terminal. Data stays in `.local/postgres`; restarting `npm run db` and `npm start` preserves users, sessions, pending requests, decisions and browser sessions. Expiry still uses the original deadline. The portable package uses forced process shutdown on Windows; PostgreSQL performs WAL recovery on restart. Do not remove a database directory while its process is running.

### Existing PostgreSQL / Docker

Copy `.env.example` to `.env` and replace placeholders with your own random credentials and a session secret of at least 32 characters. Use a dedicated, empty database. `npm run migrate` applies checksum-tracked migrations; startup also checks them. It does not touch another Testigo database or CLI.

For Docker Compose, supply random URL-safe `POSTGRES_PASSWORD` and `SESSION_SECRET` environment variables. There are **no fallback passwords**. Both variables are required because Compose validates the full configuration even when only `db` is selected.

```powershell
docker compose up -d db
# Set DATABASE_URL in .env to your dedicated database on 127.0.0.1:5432.
npm run migrate
npm run user -- --email you@example.com --role admin
npm run build
npm start
```

The user command generates a password and prints it once, or reads a supplied `BOOTSTRAP_PASSWORD` of 14–256 characters. It only creates accounts; it does not reset existing credentials. The database owner runs this command locally. Reviewers use `--role reviewer`.

Optional full Compose application:

```powershell
docker compose --profile full up --build -d
docker compose exec app npm run user -- --email you@example.com --role admin
```

Enroll a client through **Clients**, copy its one-time credential into `CLIENT_TOKEN`, then run the simulator from the host. Compose publishes only loopback ports. The application binds all interfaces **inside the isolated container**. This is not a remote production deployment. Compose is provided but was not run in the validation environment because Docker's daemon was unavailable.

## Development and validation

```powershell
npm run build       # strict TypeScript check + production Vite build
npm test            # actual PostgreSQL integration + HTML escaping tests
npm run format:check
```

Tests create independent PostgreSQL clusters under `.local/test-pg-*`, bind port 55433, generate test-only credentials, and leave the database files for inspection. They do not use your demo database. Do not run two integration suites concurrently on that port. On Windows, a restricted execution sandbox can prevent PostgreSQL from creating its required process token; run these commands from a normal local terminal. PostgreSQL is not replaced with mocks or an in-memory SQL approximation.

For UI development, run `npm run dev` and `npm run ui` separately and set `APP_ORIGIN=http://127.0.0.1:5173` before starting the API. Vite proxies `/api` to port 4310. Revert the origin to 4310 to use the compiled dashboard. The release demo uses only the compiled build.

```powershell
npm run browser:fixture  # optional hostile-HTML synthetic fixture
npm run retention       # dry-run only
npm run retention -- --apply  # explicit, irreversible purge; read docs/security.md first
```

## Contents

- `src/`: HTTP API, authentication, persistence and policy evaluation.
- `shared/api.ts`: standalone server API validation/types, independent of React and the existing Testigo protocol.
- `ui/`: English React dashboard, polling every three seconds.
- `migrations/`: PostgreSQL schema and database immutability constraints.
- `scripts/`: explicit bootstrap, portable database, simulator and retention tools.
- [API and reproducible requests](docs/api.md).
- [Security, retention and limitations](docs/security.md).
- [Validation results and browser checklist](docs/validation.md).
- [Original agreed implementation plan](docs/implementation-plan.md).

This standalone project does not modify the existing Testigo plugin, hooks, CLI, signing configuration, protocol files or user settings. It has no runtime dependency on the original repository.
