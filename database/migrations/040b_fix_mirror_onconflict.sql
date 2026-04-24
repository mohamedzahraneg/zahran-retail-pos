-- 040b — replace partial unique index with a non-partial one so
-- ON CONFLICT (source_ref_type, source_ref_id) resolves. Partial indexes
-- can be used as an ON CONFLICT target only by repeating the predicate,
-- which clutters every mirror trigger. A regular unique index is simpler
-- and NULL values don't conflict with each other in Postgres anyway.

DROP INDEX IF EXISTS uq_emp_txn_source;
CREATE UNIQUE INDEX uq_emp_txn_source
    ON employee_transactions(source_ref_type, source_ref_id);
