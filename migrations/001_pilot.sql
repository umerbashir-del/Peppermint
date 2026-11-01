CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE suppliers (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE branches (supplier_id text REFERENCES suppliers(id), id text, name text NOT NULL, PRIMARY KEY(supplier_id,id));
CREATE TABLE accounts (supplier_id text REFERENCES suppliers(id), id text, name text NOT NULL, PRIMARY KEY(supplier_id,id));
CREATE TABLE memberships (
  user_id text REFERENCES users(id), supplier_id text REFERENCES suppliers(id),
  role text NOT NULL CHECK(role IN ('admin','staff','credit_manager','contractor')),
  PRIMARY KEY(user_id,supplier_id)
);
CREATE TABLE access_grants (
  id text PRIMARY KEY, user_id text NOT NULL, supplier_id text NOT NULL, branch_id text, account_id text NOT NULL,
  FOREIGN KEY(user_id,supplier_id) REFERENCES memberships(user_id,supplier_id) ON DELETE CASCADE,
  FOREIGN KEY(supplier_id,branch_id) REFERENCES branches(supplier_id,id),
  FOREIGN KEY(supplier_id,account_id) REFERENCES accounts(supplier_id,id),
  UNIQUE(user_id,supplier_id,branch_id,account_id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE activation_tokens (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
CREATE TABLE quotas (
  bucket text PRIMARY KEY, used bigint NOT NULL, reset_at timestamptz NOT NULL
);
CREATE TABLE quotes (
  id text PRIMARY KEY, supplier_id text NOT NULL REFERENCES suppliers(id), branch_id text NOT NULL, account_id text NOT NULL,
  request_id text NOT NULL, save_id text NOT NULL, input_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('draft','approved','sent','accepted','order_requested','cancelled')),
  current_revision integer NOT NULL CHECK(current_revision > 0), approved_revision integer, published_revision integer,
  created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(supplier_id,branch_id) REFERENCES branches(supplier_id,id),
  FOREIGN KEY(supplier_id,account_id) REFERENCES accounts(supplier_id,id), UNIQUE(supplier_id,request_id,save_id)
);
CREATE INDEX quotes_scope ON quotes(supplier_id,branch_id,account_id);
CREATE TABLE quote_revisions (
  quote_id text REFERENCES quotes(id), revision integer NOT NULL,
  payload jsonb NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(quote_id,revision)
);
CREATE TABLE quote_events (
  id text PRIMARY KEY, supplier_id text NOT NULL REFERENCES suppliers(id), quote_id text REFERENCES quotes(id),
  revision integer, actor_id text REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_quote ON quote_events(quote_id,created_at);
CREATE TABLE credit_exceptions (
  quote_id text REFERENCES quotes(id), revision integer NOT NULL,
  limit_cents bigint NOT NULL CHECK(limit_cents >= 0), reason text NOT NULL,
  approved_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(quote_id,revision)
);
CREATE TABLE order_requests (
  id text PRIMARY KEY, quote_id text NOT NULL UNIQUE REFERENCES quotes(id), revision integer NOT NULL,
  status text NOT NULL CHECK(status = 'pending_external_confirmation'), created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_usage (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), supplier_id text NOT NULL REFERENCES suppliers(id), task_id text NOT NULL,
  input_tokens bigint NOT NULL, output_tokens bigint NOT NULL, search_requests integer NOT NULL, elapsed_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable audit/revision records cannot be changed'; END $$;
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON quote_revisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON quote_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_exceptions BEFORE UPDATE OR DELETE ON credit_exceptions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
