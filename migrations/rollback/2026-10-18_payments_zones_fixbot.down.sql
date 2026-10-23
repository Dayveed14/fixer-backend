-- Reverses 2026-10-18 (a). DESTRUCTIVE: drops the payment ledger and
-- audit trail. Only for a database that has never taken real payments
-- under this schema — otherwise restore from a backup instead.
ALTER TABLE diagnosis_requests
  DROP COLUMN latency_ms,
  DROP COLUMN failure_reason,
  DROP COLUMN result_source;

ALTER TABLE shipments DROP KEY uq_shipments_payment_reference;
ALTER TABLE bookings  DROP KEY uq_bookings_payment_reference;

ALTER TABLE shipments DROP KEY idx_shipments_user;
ALTER TABLE shipments
  DROP COLUMN pickup_zone,
  DROP COLUMN user_id;

DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS payment_transactions;
