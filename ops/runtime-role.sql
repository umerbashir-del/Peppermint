-- Run as the database owner after migrations. Provision a separate login in
-- your hosting secret manager, then GRANT buildbridge_runtime TO that login.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='buildbridge_runtime') THEN CREATE ROLE buildbridge_runtime NOLOGIN; END IF; END $$;
GRANT USAGE ON SCHEMA public TO buildbridge_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON users,memberships,access_grants,sessions,activation_tokens,quotas,quotes,order_requests,model_usage,credit_reservations TO buildbridge_runtime;
GRANT SELECT,INSERT ON suppliers,branches,accounts,quote_revisions,quote_events,credit_exceptions,tax_approvals,worker_results TO buildbridge_runtime;
GRANT SELECT ON schema_migrations TO buildbridge_runtime;
-- No schema ownership, TRUNCATE, migration rights, or audit/revision mutation.
