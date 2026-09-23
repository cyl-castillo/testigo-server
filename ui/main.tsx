import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Rule,
  RequestRecord,
  ClientRecord,
  SessionRecord,
  EventRecord,
  AuditRecord,
} from "../shared/api";
import "./style.css";
import { JsonDetail } from "./JsonDetail";
type User = { email: string; role: string };
type Policy = { id: number; rules: Rule[]; created_at: string };
type EventPage = {
  events: EventRecord[];
  hasMore: boolean;
  gaps: { source_id: string; missing_from: number; missing_to: number }[];
  moreGaps: boolean;
  sources: {
    source_id: string;
    received: string;
    first_sequence: number;
    last_sequence: number;
  }[];
};
let csrf = "";
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error +
        (data.issues
          ? ": " +
            data.issues.map((i: { message: string }) => i.message).join("; ")
          : ""),
    );
  return data;
}
const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "No contact yet";
function Badge({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("Overview");
  const [clients, setClients] = useState<ClientRecord[]>([]),
    [sessions, setSessions] = useState<SessionRecord[]>([]),
    [requests, setRequests] = useState<RequestRecord[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null),
    [audit, setAudit] = useState<AuditRecord[]>([]);
  const [selected, setSelected] = useState<RequestRecord | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  const [requestFilter, setRequestFilter] = useState("pending");
  const [clientFilter, setClientFilter] = useState(""),
    [caseFilter, setCaseFilter] = useState(""),
    [sessionFilter, setSessionFilter] = useState("");
  const [eventPage, setEventPage] = useState<EventPage | null>(null),
    [toolFilter, setToolFilter] = useState(""),
    [outcomeFilter, setOutcomeFilter] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [offset, setOffset] = useState(0);
  const [rules, setRules] = useState<Rule[]>([]),
    [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [history, setHistory] = useState<Policy[]>([]),
    [newToken, setNewToken] = useState(""),
    [newClient, setNewClient] = useState("");
  const [auditOlder, setAuditOlder] = useState(false);
  async function load() {
    const [c, s, r, p, a] = await Promise.all([
      api<ClientRecord[]>("/clients"),
      api<SessionRecord[]>("/sessions"),
      api<RequestRecord[]>("/requests"),
      api<Policy>("/policy"),
      api<AuditRecord[]>("/audit"),
    ]);
    setClients(c);
    setSessions(s);
    setRequests(r);
    setPolicy(p);
    if (!auditOlder) setAudit(a);
    setSelected((old) =>
      old ? (r.find((x) => x.id === old.id) ?? old) : null,
    );
  }
  useEffect(() => {
    api<{ user: User; csrf: string }>("/me")
      .then((data) => {
        csrf = data.csrf;
        setUser(data.user);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!user) return;
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void load().catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [user, auditOlder]);
  useEffect(() => {
    setOffset(0);
  }, [sessionFilter, toolFilter, outcomeFilter, from, to]);
  useEffect(() => {
    if (!sessionFilter) {
      setEventPage(null);
      return;
    }
    let active = true;
    async function events() {
      const q = new URLSearchParams({ offset: String(offset) });
      if (toolFilter) q.set("tool", toolFilter);
      if (outcomeFilter) q.set("outcome", outcomeFilter);
      if (from) q.set("from", new Date(from).toISOString());
      if (to) q.set("to", new Date(to).toISOString());
      try {
        const page = await api<EventPage>(
          `/sessions/${sessionFilter}/events?${q}`,
        );
        if (active) setEventPage(page);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void events();
    const timer = setInterval(() => void events(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionFilter, toolFilter, outcomeFilter, from, to, offset]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pending = requests.filter((r) => r.state === "pending");
  const filteredSessions = sessions.filter(
    (s) =>
      (!clientFilter || s.client_id === clientFilter) &&
      (!caseFilter || s.case_ref === caseFilter),
  );
  const visibleRequests = requests.filter(
    (r) => !requestFilter || r.state === requestFilter,
  );
  const roleAdmin = user?.role === "admin";
  async function signOut() {
    try {
      await api("/logout", "POST", {});
      csrf = "";
      setUser(null);
      setNewToken("");
      setSelected(null);
      setEditingVersion(null);
      setRules([]);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!ready)
    return (
      <main className="login">
        <p>Connecting to Testigo…</p>
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-brand">
          <span className="mark">t.</span>
          <span>TESTIGO / SERVER POC</span>
        </div>
        <div className="login-content">
          <div>
            <p className="eyebrow">A CLEARER RECORD</p>
            <h1>
              Every request.
              <br />A considered decision.
            </h1>
            <p>
              Review proposed commands, follow sessions and keep a shared record
              of what was authorized.
            </p>
            <div className="login-note">
              Synthetic demonstration · No Claude integration
            </div>
          </div>
          <form
            className="login-card"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setError("");
              void api<{ user: User; csrf: string }>("/login", "POST", {
                email: form.get("email"),
                password: form.get("password"),
              })
                .then((data) => {
                  csrf = data.csrf;
                  setUser(data.user);
                })
                .catch((err) => setError(err.message));
            }}
          >
            <h2>Welcome back</h2>
            <p>Sign in to your local workspace.</p>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="primary">Sign in →</button>
            <small>
              First run? Use the generated credentials in{" "}
              <code>.local/access.txt</code>.
            </small>
          </form>
        </div>
        <footer>
          Device identity is not proof of the person acting. All evidence in
          this POC is not verified.
        </footer>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">t.</span>
          <div>
            testigo<small>SESSION OVERSIGHT</small>
          </div>
        </div>
        <div className="workspace">
          <span className="workspace-icon">D</span>
          <div>
            Demo workspace<small>Single company · Local POC</small>
          </div>
        </div>
        <nav>
          {[
            "Overview",
            "Approvals",
            "Sessions",
            "Clients",
            "Policy",
            "Audit trail",
          ].map((name) => (
            <button
              key={name}
              className={tab === name ? "active" : ""}
              onClick={() => {
                setTab(name);
                setError("");
                setNotice("");
              }}
            >
              <span className="nav-dot" />
              {name}
              {name === "Approvals" && pending.length > 0 && (
                <b>{pending.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="live-dot" /> Polling every 3 seconds
          <p>
            Simulation only
            <br />
            Evidence: not verified
          </p>
          <small>
            {user.email}
            <br />
            {user.role}
          </small>
          <button className="signout" onClick={() => void signOut()}>
            Sign out ↗
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> {tab}
          </span>
          <Badge tone="neutral">LOCAL DEMO</Badge>
          <button className="mobile-signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">TESTIGO CONTROL ROOM</p>
              <h1>
                {tab === "Overview"
                  ? "A shared view of every session."
                  : tab === "Approvals"
                    ? "Decisions that stay on record."
                    : tab === "Sessions"
                      ? "Follow the source."
                      : tab === "Clients"
                        ? "Connected workstations."
                        : tab === "Policy"
                          ? "Rules, with a history."
                          : "The decision trail."}
              </h1>
              <p className="subtitle">
                {tab === "Overview"
                  ? "Proposed actions, human decisions and reported outcomes — in one place."
                  : tab === "Approvals"
                    ? "Review the exact input. Each approval applies to one immutable request."
                    : tab === "Sessions"
                      ? "Source timestamps and receive times remain separate. Shared case references are explicit."
                      : tab === "Clients"
                        ? "Recent contact indicates connectivity, not complete capture or human identity."
                        : tab === "Policy"
                          ? "Server-side evaluation. Changes cancel undecided requests and require resubmission."
                          : "Who decided, when, and why. Authorization and execution are separate facts."}
              </p>
            </div>
            <span className="date">
              {new Date().toLocaleDateString("en", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {tab === "Overview" && (
            <>
              <div className="stats">
                <div>
                  <span>Awaiting review</span>
                  <strong>{pending.length.toString().padStart(2, "0")}</strong>
                  <small>Human approval required</small>
                </div>
                <div>
                  <span>Active sessions</span>
                  <strong>
                    {sessions
                      .filter((s) => s.status === "active")
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>{sessions.length} sessions in this workspace</small>
                </div>
                <div>
                  <span>Registered clients</span>
                  <strong>
                    {clients
                      .filter((c) => !c.revoked_at)
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>Credentials can be revoked</small>
                </div>
                <div>
                  <span>Policy version</span>
                  <strong>
                    <i>v</i>
                    {policy?.id ?? "—"}
                  </strong>
                  <small>Immutable evaluation history</small>
                </div>
              </div>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>
                      Needs your attention{" "}
                      <Badge tone="pending">{pending.length}</Badge>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => setTab("Approvals")}
                    >
                      View approvals ↗
                    </button>
                  </div>
                  {!pending.length ? (
                    <Empty>
                      No pending requests. Run the simulator to begin.
                    </Empty>
                  ) : (
                    pending.slice(0, 4).map((r) => (
                      <button
                        className="request-preview"
                        key={r.id}
                        onClick={() => {
                          setSelected(r);
                          setReason("");
                          setTab("Approvals");
                        }}
                      >
                        <div>
                          <Badge>{r.payload.tool}</Badge>
                          <code>{r.payload.arguments.command}</code>
                          <small>
                            {r.client_name} · {r.session_title}
                          </small>
                        </div>
                        <span>Review →</span>
                      </button>
                    ))
                  )}
                </section>
                <section className="panel boundary">
                  <p className="eyebrow">READ THE RECORD CAREFULLY</p>
                  <h2>
                    Permission is one step.
                    <br />
                    Execution is another.
                  </h2>
                  <p>
                    “Permitted by Testigo” never overrides native Claude
                    permissions. A reported completion here is always simulated.
                  </p>
                  <div className="boundary-line" />
                  <p>
                    No submitted command is executed.
                    <br />
                    No source signatures are verified.
                  </p>
                  <Badge tone="neutral">POC BOUNDARY</Badge>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>Recent sessions</h2>
                  <button
                    className="text-button"
                    onClick={() => setTab("Sessions")}
                  >
                    All sessions ↗
                  </button>
                </div>
                <SessionTable
                  rows={sessions.slice(0, 5)}
                  open={(s) => {
                    setSessionFilter(s.id);
                    setTab("Sessions");
                  }}
                />
              </section>
            </>
          )}
          {tab === "Approvals" && (
            <>
              <div className="filter-tabs">
                {[
                  "pending",
                  "",
                  "approved",
                  "denied",
                  "expired",
                  "cancelled",
                ].map((s) => (
                  <button
                    key={s}
                    className={requestFilter === s ? "chosen" : ""}
                    onClick={() => setRequestFilter(s)}
                  >
                    {s || "All requests"}
                    {s === "pending" && <span>{pending.length}</span>}
                  </button>
                ))}
              </div>
              <div
                className={"approval-layout " + (selected ? "with-detail" : "")}
              >
                <section className="panel request-list">
                  {visibleRequests.length === 0 ? (
                    <Empty>No requests in this view.</Empty>
                  ) : (
                    visibleRequests.map((r) => (
                      <button
                        key={r.id}
                        className={
                          "request-item " +
                          (selected?.id === r.id ? "selected" : "")
                        }
                        onClick={() => {
                          setSelected(r);
                          setReason("");
                        }}
                      >
                        <div className="row-between">
                          <Badge tone={r.state}>
                            {r.evaluation === "permit" && r.state === "approved"
                              ? "Permitted by Testigo"
                              : r.state}
                          </Badge>
                          <small>
                            {new Date(r.created_at).toLocaleTimeString()}
                          </small>
                        </div>
                        <code>{r.payload.arguments.command}</code>
                        <small>
                          {r.client_name} · {r.payload.tool}
                        </small>
                        <div className="request-meta">
                          Policy v{r.policy_version}{" "}
                          <span>
                            {r.report
                              ? "Simulated result received"
                              : r.claimed_at
                                ? "Authorization claimed"
                                : `Expires ${new Date(r.expires_at).toLocaleTimeString()}`}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </section>
                {selected && (
                  <section className="panel details">
                    <div className="panel-title">
                      <h2>Request detail</h2>
                      <button
                        className="text-button"
                        onClick={() => setSelected(null)}
                      >
                        Close ×
                      </button>
                    </div>
                    <div className="detail-body">
                      <Badge tone={selected.state}>{selected.state}</Badge>
                      <h3>Exact proposed input</h3>
                      <JsonDetail
                        testId="request-input"
                        value={{
                          tool: selected.payload.tool,
                          arguments: selected.payload.arguments,
                          cwd: selected.payload.cwd,
                          environment: selected.payload.environment,
                        }}
                      />
                      <p className="muted">
                        Environment is client supplied. No independent
                        verification.
                      </p>
                      <dl>
                        <dt>Client</dt>
                        <dd>
                          {selected.client_name}
                          <small>{selected.client_id}</small>
                        </dd>
                        <dt>Session</dt>
                        <dd>
                          {selected.session_title}
                          <small>{selected.session_id}</small>
                        </dd>
                        <dt>Operation</dt>
                        <dd>{selected.operation_id}</dd>
                        <dt>Created</dt>
                        <dd>{when(selected.created_at)}</dd>
                        <dt>Expires</dt>
                        <dd>{when(selected.expires_at)}</dd>
                        <dt>Evaluation</dt>
                        <dd>
                          {selected.evaluation === "permit"
                            ? "Permitted by Testigo"
                            : selected.evaluation === "deny"
                              ? "Denied"
                              : "Pending human approval"}{" "}
                          · policy v{selected.policy_version}
                        </dd>
                        <dt>Matched rules</dt>
                        <dd>
                          {selected.matched_rules.join(", ") ||
                            "Unmatched shell request → approval"}
                        </dd>
                        <dt>Request digest</dt>
                        <dd>
                          <code className="digest">{selected.digest}</code>
                        </dd>
                      </dl>
                      <h3>Supporting context</h3>
                      <pre>
                        {selected.payload.context || "No context submitted."}
                      </pre>
                      {selected.state === "pending" ? (
                        <div className="decision-form">
                          <label>
                            Reason <span className="muted">(optional)</span>
                            <textarea
                              value={reason}
                              maxLength={2000}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="Add context to the decision trail"
                            />
                          </label>
                          <p className="muted">
                            One request. One claim. Native permissions still
                            apply.
                          </p>
                          <div className="button-row">
                            <button
                              disabled={busy}
                              className="danger-outline"
                              onClick={() =>
                                void action(async () => {
                                  await api(
                                    `/requests/${selected.id}/decision`,
                                    "POST",
                                    {
                                      decision: "denied",
                                      reason,
                                      digest: selected.digest,
                                    },
                                  );
                                  setNotice(
                                    "Request denied. Decision recorded.",
                                  );
                                })
                              }
                            >
                              Deny request
                            </button>
                            <button
                              disabled={busy}
                              className="primary"
                              onClick={() =>
                                void action(async () => {
                                  await api(
                                    `/requests/${selected.id}/decision`,
                                    "POST",
                                    {
                                      decision: "approved",
                                      reason,
                                      digest: selected.digest,
                                    },
                                  );
                                  setNotice(
                                    "Request approved. Execution is not implied.",
                                  );
                                })
                              }
                            >
                              Approve once
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="decision-record">
                          <h3>Authorization record</h3>
                          {selected.decision ? (
                            <p>
                              {selected.decision.decision} by{" "}
                              {selected.decision.reviewer}
                              <br />
                              {when(selected.decision.decided_at)}
                              <br />
                              {selected.decision.reason ||
                                "No reason supplied."}
                            </p>
                          ) : (
                            <p>
                              {selected.cancellation_reason ||
                                `Server policy evaluation: ${selected.evaluation}.`}
                            </p>
                          )}
                          <p>
                            {selected.claimed_at
                              ? `Claimed ${when(selected.claimed_at)}`
                              : "No authorization claim recorded."}
                          </p>
                          <h3>Execution report</h3>
                          {selected.report ? (
                            <>
                              <Badge tone="neutral">SIMULATED</Badge>
                              <p>
                                {selected.report.outcome} ·{" "}
                                {when(selected.report.reported_at)}
                              </p>
                              <pre>{selected.report.details}</pre>
                            </>
                          ) : (
                            <p>
                              No result reported. Approval is not proof of
                              execution.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
          {tab === "Sessions" && (
            <>
              <div className="filters">
                <label>
                  Client
                  <select
                    value={clientFilter}
                    onChange={(e) => {
                      setClientFilter(e.target.value);
                      setSessionFilter("");
                    }}
                  >
                    <option value="">All clients</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Shared case reference
                  <input
                    value={caseFilter}
                    onChange={(e) => {
                      setCaseFilter(e.target.value);
                      setSessionFilter("");
                    }}
                    placeholder="Exact reference"
                  />
                </label>
                <label>
                  Session
                  <select
                    value={sessionFilter}
                    onChange={(e) => setSessionFilter(e.target.value)}
                  >
                    <option value="">Select a session</option>
                    {filteredSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <section className="panel">
                <SessionTable
                  rows={filteredSessions}
                  open={(s) => setSessionFilter(s.id)}
                />
              </section>
              {sessionFilter && (
                <section className="panel events">
                  <div className="panel-title">
                    <h2>Event timeline</h2>
                    <Badge tone="neutral">NOT VERIFIED</Badge>
                  </div>
                  <div className="filters">
                    <label>
                      Tool
                      <input
                        value={toolFilter}
                        onChange={(e) => setToolFilter(e.target.value)}
                        placeholder="Exact tool"
                      />
                    </label>
                    <label>
                      Outcome
                      <input
                        value={outcomeFilter}
                        onChange={(e) => setOutcomeFilter(e.target.value)}
                        placeholder="Exact outcome"
                      />
                    </label>
                    <label>
                      From
                      <input
                        type="datetime-local"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </label>
                    <label>
                      To
                      <input
                        type="datetime-local"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="source-health">
                    <p>
                      Ordered by source timestamp. Each source chain remains
                      independent; timestamps do not establish causality.
                    </p>
                    {eventPage?.sources.map((s) => (
                      <p key={s.source_id}>
                        <code>{s.source_id}</code>: {s.received} received ·
                        sequence {s.first_sequence}–{s.last_sequence}
                      </p>
                    ))}
                    {eventPage?.gaps.length ? (
                      <div className="gap">
                        Sequence gaps:{" "}
                        {eventPage.gaps
                          .map(
                            (g) =>
                              `${g.source_id}: ${g.missing_from}–${g.missing_to}`,
                          )
                          .join("; ")}
                        {eventPage.moreGaps ? " (more gaps omitted)" : ""}
                      </div>
                    ) : (
                      <p>
                        No observed sequence gaps. Capture completeness is
                        unknown.
                      </p>
                    )}
                  </div>
                  {eventPage?.events.map((e) => (
                    <article className="event" key={e.id}>
                      <div>
                        <span className="timeline-dot" />
                        <strong>
                          #{e.sequence} · {e.tool || "Event"}
                        </strong>
                        <Badge>{e.outcome || "No outcome"}</Badge>
                        {e.late && <Badge tone="pending">Late arrival</Badge>}
                      </div>
                      <small>
                        Source {when(e.source_time)} · Received{" "}
                        {when(e.received_at)} · {e.source_id}
                      </small>
                      <details>
                        <summary>Original event · {e.event_id}</summary>
                        <JsonDetail testId="event-input" value={e.original} />
                      </details>
                    </article>
                  ))}
                  {eventPage?.events.length === 0 && (
                    <Empty>No events match these filters.</Empty>
                  )}
                  <div className="pagination">
                    <button
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - 200))}
                    >
                      Previous
                    </button>
                    <span>
                      Events {eventPage?.events.length ? offset + 1 : 0}–
                      {offset + (eventPage?.events.length ?? 0)}
                    </span>
                    <button
                      disabled={!eventPage?.hasMore}
                      onClick={() => setOffset(offset + 200)}
                    >
                      Next
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
          {tab === "Clients" && (
            <>
              {roleAdmin && (
                <section className="panel enroll">
                  <h2>Enroll a workstation</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        const c = await api<{ token: string }>(
                          "/clients",
                          "POST",
                          { name: newClient },
                        );
                        setNewToken(c.token);
                        setNewClient("");
                      });
                    }}
                  >
                    <input
                      aria-label="Client name"
                      value={newClient}
                      onChange={(e) => setNewClient(e.target.value)}
                      maxLength={160}
                      required
                      placeholder="Workstation name"
                    />
                    <button className="primary" disabled={busy}>
                      Issue credential
                    </button>
                  </form>
                  {newToken && (
                    <div className="notice">
                      <strong>
                        Copy this credential now. It is only returned once.
                      </strong>
                      <code className="token">{newToken}</code>
                      <button onClick={() => setNewToken("")}>
                        Dismiss credential
                      </button>
                    </div>
                  )}
                </section>
              )}
              <section className="panel">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Workstation</th>
                        <th>Recent contact</th>
                        <th>Ingestion</th>
                        <th>Status</th>
                        {roleAdmin && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.name}</strong>
                            <small>{c.id}</small>
                          </td>
                          <td>{when(c.last_contact)}</td>
                          <td>
                            {c.ingestion_errors} errors
                            <small>{c.last_error}</small>
                          </td>
                          <td>
                            <Badge tone={c.revoked_at ? "denied" : "approved"}>
                              {c.revoked_at ? "Revoked" : "Registered"}
                            </Badge>
                          </td>
                          {roleAdmin && (
                            <td>
                              {!c.revoked_at && (
                                <button
                                  disabled={busy}
                                  className="danger-outline"
                                  onClick={() =>
                                    void action(async () => {
                                      await api(
                                        `/clients/${c.id}/revoke`,
                                        "POST",
                                        {},
                                      );
                                      setNotice(
                                        "Credential revoked. Unclaimed authorizations cancelled.",
                                      );
                                    })
                                  }
                                >
                                  Revoke
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!clients.length && <Empty>No clients enrolled yet.</Empty>}
              </section>
            </>
          )}
          {tab === "Policy" && policy && (
            <>
              <div className="policy-banner">
                <Badge tone="approved">ACTIVE v{policy.id}</Badge>
                <p>
                  Deny wins → approval → permit. Unmatched commands require
                  approval. Matching is case-sensitive and does not parse shell
                  syntax. Permit rules require exact matching.
                </p>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>
                    {editingVersion === null
                      ? "Current rules"
                      : `Editing version ${editingVersion}`}
                  </h2>
                  {roleAdmin && editingVersion === null && (
                    <button
                      className="primary"
                      onClick={() => {
                        setRules(structuredClone(policy.rules));
                        setEditingVersion(policy.id);
                      }}
                    >
                      Edit policy
                    </button>
                  )}
                </div>
                <div className="table-wrap">
                  <table className="policy-table">
                    <thead>
                      <tr>
                        <th>Enabled / Rule ID</th>
                        <th>Tool</th>
                        <th>Matcher</th>
                        <th>Command</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(editingVersion === null ? policy.rules : rules).map(
                        (r, index) => (
                          <tr key={editingVersion === null ? r.id : index}>
                            {editingVersion === null ? (
                              <>
                                <td>
                                  {r.enabled ? "●" : "○"} {r.id}
                                </td>
                                <td>{r.tool}</td>
                                <td>{r.matcher}</td>
                                <td>
                                  <code>{r.value}</code>
                                </td>
                                <td>
                                  <Badge
                                    tone={
                                      r.action === "deny"
                                        ? "denied"
                                        : r.action === "permit"
                                          ? "approved"
                                          : "pending"
                                    }
                                  >
                                    {r.action}
                                  </Badge>
                                </td>
                              </>
                            ) : (
                              <>
                                <td>
                                  <input
                                    aria-label={`Enable rule ${index + 1}`}
                                    type="checkbox"
                                    checked={r.enabled}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? {
                                                ...v,
                                                enabled: e.target.checked,
                                              }
                                            : v,
                                        ),
                                      )
                                    }
                                  />
                                  <input
                                    aria-label={`Rule ID ${index + 1}`}
                                    value={r.id}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? { ...v, id: e.target.value }
                                            : v,
                                        ),
                                      )
                                    }
                                  />
                                </td>
                                <td>
                                  <select
                                    aria-label={`Rule tool ${index + 1}`}
                                    value={r.tool}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? {
                                                ...v,
                                                tool: e.target
                                                  .value as Rule["tool"],
                                              }
                                            : v,
                                        ),
                                      )
                                    }
                                  >
                                    {["*", "Bash", "PowerShell"].map((x) => (
                                      <option key={x}>{x}</option>
                                    ))}
                                  </select>
                                </td>
                                <td>
                                  <select
                                    aria-label={`Matcher ${index + 1}`}
                                    value={r.matcher}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? {
                                                ...v,
                                                matcher: e.target
                                                  .value as Rule["matcher"],
                                              }
                                            : v,
                                        ),
                                      )
                                    }
                                  >
                                    <option>exact</option>
                                    <option>prefix</option>
                                  </select>
                                </td>
                                <td>
                                  <input
                                    aria-label={`Command ${index + 1}`}
                                    value={r.value}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? { ...v, value: e.target.value }
                                            : v,
                                        ),
                                      )
                                    }
                                  />
                                </td>
                                <td>
                                  <select
                                    aria-label={`Action ${index + 1}`}
                                    value={r.action}
                                    onChange={(e) =>
                                      setRules(
                                        rules.map((v, i) =>
                                          i === index
                                            ? {
                                                ...v,
                                                action: e.target
                                                  .value as Rule["action"],
                                              }
                                            : v,
                                        ),
                                      )
                                    }
                                  >
                                    {["permit", "approval", "deny"].map((x) => (
                                      <option key={x}>{x}</option>
                                    ))}
                                  </select>
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setRules(
                                        rules.filter((_, i) => i !== index),
                                      )
                                    }
                                  >
                                    Remove
                                  </button>
                                </td>
                              </>
                            )}
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                {editingVersion !== null && (
                  <div className="policy-actions">
                    <p>
                      Publishing creates an immutable version and cancels all
                      pending requests. Existing decisions remain on record.
                    </p>
                    <div className="button-row">
                      <button
                        onClick={() =>
                          setRules([
                            ...rules,
                            {
                              id: `rule-${rules.length + 1}`,
                              enabled: true,
                              tool: "*",
                              matcher: "exact",
                              value: "",
                              action: "approval",
                            },
                          ])
                        }
                      >
                        Add rule
                      </button>
                      <button onClick={() => setEditingVersion(null)}>
                        Cancel edit
                      </button>
                      <button
                        disabled={busy}
                        className="primary"
                        onClick={() =>
                          void action(async () => {
                            await api("/policy", "PUT", {
                              baseVersion: editingVersion,
                              rules,
                            });
                            setEditingVersion(null);
                            setNotice(
                              "Policy published. Pending requests must be resubmitted.",
                            );
                          })
                        }
                      >
                        Publish version
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <p className="footnote">
                Demonstration rules are not a shell security parser. Scripts,
                aliases, quoting and compound commands limit coverage. No
                command is made safe by containing a familiar substring.
              </p>
              <button
                onClick={() =>
                  void api<Policy[]>("/policy/history")
                    .then(setHistory)
                    .catch((e) => setError(e.message))
                }
              >
                Load policy history
              </button>
              {history.map((p) => (
                <details className="history" key={p.id}>
                  <summary>
                    Version {p.id} · {when(p.created_at)}
                  </summary>
                  <pre>{JSON.stringify(p.rules, null, 2)}</pre>
                </details>
              ))}
            </>
          )}
          {tab === "Audit trail" && (
            <section className="panel">
              <div className="panel-title">
                <h2>Recorded activity</h2>
                <Badge>APPEND ONLY IN THE APPLICATION</Badge>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time / Actor</th>
                      <th>Action</th>
                      <th>Target / Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {when(a.created_at)}
                          <small>{a.actor}</small>
                        </td>
                        <td>
                          <code>{a.action}</code>
                        </td>
                        <td>
                          <small>{a.target}</small>
                          <details>
                            <summary>Details</summary>
                            <pre>{JSON.stringify(a.detail, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <button
                  disabled={!auditOlder}
                  onClick={() => {
                    setAuditOlder(false);
                    void load();
                  }}
                >
                  Latest
                </button>
                <span>Up to 200 entries per page</span>
                <button
                  disabled={audit.length < 200}
                  onClick={() =>
                    void api<AuditRecord[]>(`/audit?before=${audit.at(-1)?.id}`)
                      .then((rows) => {
                        setAuditOlder(true);
                        setAudit(rows);
                      })
                      .catch((e) => setError(e.message))
                  }
                >
                  Older entries
                </button>
              </div>
            </section>
          )}
          <footer className="page-footer">
            Testigo Server POC{" "}
            <span>
              Single-company simulation · Source evidence not verified · No
              compliance certification
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function SessionTable({
  rows,
  open,
}: {
  rows: SessionRecord[];
  open: (s: SessionRecord) => void;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Client</th>
            <th>Shared case</th>
            <th>Status</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>
                <button className="session-link" onClick={() => open(s)}>
                  {s.title} ↗
                </button>
                <small>
                  {s.fixture ? "SYNTHETIC FIXTURE" : "CLIENT-SUBMITTED"} · not
                  verified
                </small>
              </td>
              <td>{s.client_name}</td>
              <td>
                <code>{s.case_ref || "—"}</code>
              </td>
              <td>
                <Badge tone={s.status === "active" ? "approved" : "neutral"}>
                  {s.status}
                </Badge>
              </td>
              <td>{when(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>No sessions yet. Start the standalone simulator.</Empty>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
