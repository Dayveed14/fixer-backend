-- =====================================================================
-- Fixer migration — 2026-10-18
-- Run ONCE against the production database BEFORE deploying this
-- backend version. Safe to read top to bottom; each block is
-- independent. Take a backup first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Payment ledger: one row per payment attempt, created server-side
--    before the Paystack popup opens.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  reference               VARCHAR(64)  NOT NULL,
  user_id                 INT          NOT NULL,
  email                   VARCHAR(160) NOT NULL,
  purpose                 ENUM('booking', 'shipment') NOT NULL,
  amount_kobo             INT          NOT NULL,
  currency                CHAR(3)      NOT NULL DEFAULT 'NGN',
  status                  ENUM('pending', 'success', 'failed', 'abandoned', 'reversed', 'mismatch')
                          NOT NULL DEFAULT 'pending',
  failure_reason          VARCHAR(255) NULL,
  metadata                JSON         NULL,
  paystack_transaction_id BIGINT       NULL,
  channel                 VARCHAR(30)  NULL,
  entity_type             ENUM('booking', 'shipment') NULL,
  entity_id               INT          NULL,
  paid_at                 DATETIME     NULL,
  fulfilled_at            DATETIME     NULL,
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_reference (reference),
  -- one payment can only ever produce one booking/shipment
  UNIQUE KEY uq_payment_entity (entity_type, entity_id),
  KEY idx_payment_user (user_id),
  KEY idx_payment_status (status)
);

-- ---------------------------------------------------------------------
-- 2. Payment audit trail: every status change, who/what caused it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  reference     VARCHAR(64)  NOT NULL,
  event         VARCHAR(40)  NOT NULL,   -- created | status_changed | fulfilled | verify_unavailable
  from_status   VARCHAR(20)  NULL,
  to_status     VARCHAR(20)  NULL,
  source        VARCHAR(20)  NOT NULL,   -- api | verify | webhook
  actor_user_id INT          NULL,
  detail        VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payment_events_reference (reference)
);

-- ---------------------------------------------------------------------
-- 3. Shipments: link to the customer's account and record the Abuja
--    pickup zone that set the fee.
-- ---------------------------------------------------------------------
ALTER TABLE shipments
  ADD COLUMN user_id     INT         NULL AFTER reference,
  ADD COLUMN pickup_zone VARCHAR(40) NULL AFTER city;

ALTER TABLE shipments ADD KEY idx_shipments_user (user_id);

-- Backfill user_id for existing shipments where the email matches an account.
UPDATE shipments s
  JOIN users u ON LOWER(u.email) = LOWER(s.email)
   SET s.user_id = u.id
 WHERE s.user_id IS NULL;

-- ---------------------------------------------------------------------
-- 4. A payment reference can only be used once per table (backstop for
--    the application-level check). Skip a line if your table already
--    has a unique index on payment_reference — MySQL will error with
--    "Duplicate key name" and nothing changes.
-- ---------------------------------------------------------------------
ALTER TABLE bookings  ADD UNIQUE KEY uq_bookings_payment_reference  (payment_reference);
ALTER TABLE shipments ADD UNIQUE KEY uq_shipments_payment_reference (payment_reference);

-- ---------------------------------------------------------------------
-- 5. FixBot: how each diagnosis was answered, for investigating
--    failures (no extra customer text, no IP addresses).
-- ---------------------------------------------------------------------
ALTER TABLE diagnosis_requests
  ADD COLUMN result_source  VARCHAR(20) NULL,   -- knowledge_base | ai | no_match
  ADD COLUMN failure_reason VARCHAR(40) NULL,   -- ai_timeout | ai_unavailable | ai_invalid_response | ai_daily_limit | ai_capacity
  ADD COLUMN latency_ms     INT         NULL;
