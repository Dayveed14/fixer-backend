-- Reverses 2026-10-18b. Loses: repair quotes/approvals, the shipment
-- timeline and admin-set prices (the app falls back to config/pricing.js).
-- The purpose/entity_type change back to ENUM FAILS ON PURPOSE if any
-- repair/return payments exist — those are real money and must be dealt
-- with (exported) by hand before rolling back this far. It runs first,
-- so a refusal leaves everything else untouched.
ALTER TABLE payment_transactions
  MODIFY purpose     ENUM('booking', 'shipment') NOT NULL,
  MODIFY entity_type ENUM('booking', 'shipment') NULL;

DROP TABLE IF EXISTS pricing_settings;
DROP TABLE IF EXISTS dispatch_zones;
DROP TABLE IF EXISTS pricing_support_types;
DROP TABLE IF EXISTS shipment_events;

ALTER TABLE shipments DROP KEY idx_shipments_delivery_due;

ALTER TABLE shipments
  DROP COLUMN delivery_confirmed_by,
  DROP COLUMN delivered_at,
  DROP COLUMN delivery_confirm_by,
  DROP COLUMN ready_at,
  DROP COLUMN approval_amount_paid,
  DROP COLUMN approval_payment_reference,
  DROP COLUMN approval_at,
  DROP COLUMN approval_status,
  DROP COLUMN quoted_at,
  DROP COLUMN quote_total,
  DROP COLUMN return_fee,
  DROP COLUMN repair_cost,
  DROP COLUMN diagnosis_summary;
