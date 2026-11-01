CREATE TABLE credit_reservations (
  quote_id text PRIMARY KEY REFERENCES quotes(id), supplier_id text NOT NULL REFERENCES suppliers(id), account_id text NOT NULL,
  revision integer NOT NULL, total_cents bigint NOT NULL CHECK(total_cents>=0), valid_until timestamptz NOT NULL,
  FOREIGN KEY(supplier_id,account_id) REFERENCES accounts(supplier_id,id)
);
CREATE INDEX credit_reservations_account ON credit_reservations(supplier_id,account_id);
-- Existing commitments must consume exposure immediately after this upgrade.
INSERT INTO credit_reservations(quote_id,supplier_id,account_id,revision,total_cents,valid_until)
SELECT q.id,q.supplier_id,q.account_id,q.current_revision,
       (r.payload->'commercial'->>'total_cents')::bigint,
       (r.payload->'terms'->>'valid_until')::timestamptz
FROM quotes q JOIN quote_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision
WHERE q.state IN ('approved','sent','accepted','order_requested');
-- Missing/invalid legacy totals or expiration fail migration rather than losing exposure.
CREATE TABLE tax_approvals (
  quote_id text REFERENCES quotes(id), revision integer NOT NULL, reason text NOT NULL,
  approved_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(quote_id,revision)
);
CREATE TRIGGER immutable_tax_approvals BEFORE UPDATE OR DELETE ON tax_approvals FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TABLE worker_results (
  id text PRIMARY KEY, supplier_id text NOT NULL, branch_id text NOT NULL, account_id text NOT NULL,
  actor_id text NOT NULL REFERENCES users(id), request_id text NOT NULL, task_id text NOT NULL, input_hash text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(supplier_id,branch_id) REFERENCES branches(supplier_id,id), FOREIGN KEY(supplier_id,account_id) REFERENCES accounts(supplier_id,id)
);
CREATE INDEX worker_results_task ON worker_results(supplier_id,request_id,task_id,input_hash);
CREATE TRIGGER immutable_worker_results BEFORE UPDATE OR DELETE ON worker_results FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
ALTER TABLE quotes DROP CONSTRAINT quotes_state_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_state_check CHECK(state IN ('draft','approved','sent','accepted','order_requested','ordered','cancelled'));
ALTER TABLE order_requests DROP CONSTRAINT order_requests_status_check;
ALTER TABLE order_requests ADD CONSTRAINT order_requests_status_check CHECK(status IN ('pending_external_confirmation','confirmed'));
ALTER TABLE order_requests ADD COLUMN external_reference text;
