# Validation record

Date: 2026-09-22. Environment: Windows x64, Node 22.16.0, npm 10.9.2, native PostgreSQL **17.10** (`x86_64-windows`, MSVC 19.44). All database integration tests ran against the real PostgreSQL server with separate TCP connections and a real connection pool. No database mock or PGlite substitute was used.

## Automated checks

`npm run build`: passed strict TypeScript checking and Vite production build.

`npm run format:check`: passed. `npm run retention`: passed in dry-run mode against the demo, with no eligible deletions. `docker compose config --quiet`: passed configuration validation; this does not validate container build or runtime.

`npm test`: **17 passed, 0 failed, 0 skipped**. Fifteen API/database tests plus two React rendering tests. Final suite duration approximately nine seconds. Test clusters are separate from the interactive demo.

| Coverage | Result |
|---|---|
| Administrator/reviewer privileges, anonymous access and bearer/cookie separation | Passed |
| HttpOnly/SameSite cookie, exact origin checks, CSRF requirement, login failure | Passed |
| Client isolation for session reads/writes, completion, request creation/status, claims, cancellation and reports | Passed |
| Case-sensitive exact/prefix boundaries, compound commands, PowerShell, unmatched approval, deny/approval/permit precedence | Passed |
| Session retry binding, duplicate events, conflicting IDs/sequences, atomic batch rollback, source provenance, independent chains, late arrivals and gaps | Passed |
| Eight concurrent identical operation submissions produce one request; context/command/tool/TTL changes conflict | Passed |
| Policy versioning, stale-editor protection, pending cancellation, required resubmission and preservation of existing decisions | Passed |
| Three simultaneous reviewers produce one decision and one decision audit entry | Passed |
| Ten simultaneous claim attempts produce one claim; wrong digest rejected | Passed |
| Report secret required, simulated-only reporting, identical retry, immutable result, separate authorization record | Passed |
| Expiry enforced during status reads, human decision and claim without a scheduler | Passed |
| Client revocation/session completion invalidate unclaimed requests | Passed |
| Human rejection/client cancellation prevent claiming | Passed |
| Database rejects rewrites of source events, policies, request bindings, decisions and audit history | Passed |
| TTL, body-size, JSON-depth and NUL validation | Passed |
| Retention dry-run; explicit whole-session purge; persistent deletion tombstone; unreported claimed requests protected | Passed |
| Application **and PostgreSQL process restart** preserve sessions, pending requests and browser authentication | Passed |
| Event/request detail renderer escapes malicious HTML, including closing tags, scripts, images and iframes | Passed |

Dependency installation reported zero known npm audit vulnerabilities at validation time. This is not a security certification.

## Interactive browser acceptance

Verified in the Codex in-app Chromium browser against the running compiled application at `http://127.0.0.1:4310`, not just server-rendered markup:

1. Generated administrator credentials successfully signed in. Overview and navigation rendered correctly; desktop screenshot visually inspected.
2. The standalone simulator created two sessions sharing a synthetic case reference, with two pending `git push` requests.
3. Approved `demo-approved` in the dashboard with a reason. The request immediately showed the authorization record and initially no execution result. Polling then displayed a separately timestamped claim and **SIMULATED** completion.
4. Rejected `demo-rejected` through the dashboard with a reason. No claim or execution result appeared.
5. All-requests view showed the seeded policy permit (`git status`), policy denial (synthetic destructive example), human approval, human rejection and expired request.
6. Simulator output confirmed an identical event retry accepted zero new events and counted one duplicate; the repeated permitted request retained its ID; both original simulation sessions completed.
7. An additional hostile-HTML fixture was created with `npm run browser:fixture`. Request arguments/context and expanded original event displayed literal `<img …>` and `<script>…</script>` text. DOM inspection found **zero images and zero inline scripts** on both detail views. No submitted HTML became executable elements.
8. Tool filtering to PowerShell hid the Bash-only fixture; clearing the filter restored it. The release session visibly showed source sequence 2 as a late arrival and the missing range 4–4.
9. Opened the administrator policy editor and published a new version with the same rules. The pending HTML fixture was cancelled by the policy change. Existing completed decisions remained available.

The full simulator's first verified case was `DEMO-713f527e`. Additional demo runs may be present so the user has fresh pending requests to try. Browser actions were acceptance-test actions on synthetic data, not real human authorization of a shell execution.

## Reproduce

```powershell
npm ci
npm run build
npm test
npm run format:check
```

For the browser walkthrough, follow the README, run `npm run simulate` and use the dashboard. For the hostile-text check, run `npm run browser:fixture`, inspect the new request, then Sessions → Untrusted text → Original event. Expected result is visible literal markup and no added DOM images/inline scripts. Publish a policy version to verify pending cancellation.

## Not verified / limitations

- Docker's daemon was unavailable. Docker Compose and Dockerfile are provided; container build/run was **not** tested.
- No remote HTTPS/proxy installation, production deployment, external evidence source, native Testigo signature verification, Claude plugin integration or real shell execution was attempted.
- No cross-browser matrix, formal accessibility audit, production load test, password recovery, backup/restore drill or security penetration test was performed.
- The browser acceptance workflow is documented manual automation through the available browser tool; there is no unattended Playwright browser runner shipped as a passing test suite.
- Tests preserve isolated PostgreSQL directories under `.local` for inspection. Those directories and generated secrets are ignored, never part of source delivery.
