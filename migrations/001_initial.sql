CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('admin','reviewer')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE browser_sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
CREATE INDEX browser_sessions_expire ON browser_sessions(expire);
CREATE TABLE clients (
 id uuid PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, last_contact timestamptz,
 ingestion_errors integer NOT NULL DEFAULT 0, last_error text
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), source_id text NOT NULL,
 title text NOT NULL, case_ref text, fixture boolean NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(client_id, source_id)
);
CREATE TABLE events (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 event_id text NOT NULL, source_id text NOT NULL, sequence integer NOT NULL CHECK(sequence>=1),
 source_time timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), late boolean NOT NULL,
 original jsonb NOT NULL, content_digest text NOT NULL, tool text, outcome text,
 UNIQUE(session_id,source_id,event_id), UNIQUE(session_id,source_id,sequence)
);
CREATE INDEX events_session_time ON events(session_id,source_time);
CREATE TABLE policy_versions (id serial PRIMARY KEY, rules jsonb NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE policy_head (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version_id integer NOT NULL REFERENCES policy_versions(id));
CREATE TABLE execution_requests (
 id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 operation_id text NOT NULL, payload jsonb NOT NULL, digest text NOT NULL,
 policy_version integer NOT NULL REFERENCES policy_versions(id), matched_rules jsonb NOT NULL, evaluation text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','approved','denied','expired','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 claimed_at timestamptz, claim_hash text, cancellation_reason text,
 UNIQUE(client_id,operation_id)
);
CREATE INDEX requests_pending ON execution_requests(state,expires_at);
CREATE TABLE approval_decisions (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES execution_requests(id) ON DELETE CASCADE,
 reviewer_id uuid NOT NULL REFERENCES users(id), decision text NOT NULL CHECK(decision IN ('approved','denied')),
 reason text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE execution_reports (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES execution_requests(id) ON DELETE CASCADE,
 simulated boolean NOT NULL CHECK(simulated), outcome text NOT NULL, details text NOT NULL, digest text NOT NULL,
 reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_entries (
 id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable record'; END $$;
CREATE TRIGGER immutable_event BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER immutable_policy BEFORE UPDATE OR DELETE ON policy_versions FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER immutable_decision BEFORE UPDATE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER immutable_report BEFORE UPDATE ON execution_reports FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_entries FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE FUNCTION protect_request_binding() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF ROW(NEW.payload,NEW.digest,NEW.client_id,NEW.session_id,NEW.operation_id,NEW.policy_version,NEW.matched_rules,NEW.evaluation,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.payload,OLD.digest,OLD.client_id,OLD.session_id,OLD.operation_id,OLD.policy_version,OLD.matched_rules,OLD.evaluation,OLD.expires_at,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable request binding'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER immutable_request_binding BEFORE UPDATE ON execution_requests FOR EACH ROW EXECUTE FUNCTION protect_request_binding();
