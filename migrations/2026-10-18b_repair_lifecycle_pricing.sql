-- =====================================================================
-- Fixer migration — 2026-10-18 (part 2): repair lifecycle + pricing engine
-- Run AFTER 2026-10-18_payments_zones_fixbot.sql. Back up first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New payment purposes: repair (approve quote) and return (decline).
-- ---------------------------------------------------------------------
ALTER TABLE payment_transactions
  MODIFY purpose     VARCHAR(20) NOT NULL,
  MODIFY entity_type VARCHAR(30) NULL;

-- ---------------------------------------------------------------------
-- 2. Shipment quote, approval and delivery-confirmation fields.
-- ---------------------------------------------------------------------
ALTER TABLE shipments
  ADD COLUMN diagnosis_summary          TEXT          NULL,
  ADD COLUMN repair_cost                DECIMAL(12,2) NULL,
  ADD COLUMN return_fee                 DECIMAL(12,2) NULL,
  ADD COLUMN quote_total                DECIMAL(12,2) NULL,
  ADD COLUMN quoted_at                  DATETIME      NULL,
  ADD COLUMN approval_status            ENUM('pending','approved','declined') NULL,
  ADD COLUMN approval_at                DATETIME      NULL,
  ADD COLUMN approval_payment_reference VARCHAR(64)   NULL,
  ADD COLUMN approval_amount_paid       DECIMAL(12,2) NULL,
  ADD COLUMN ready_at                   DATETIME      NULL,
  ADD COLUMN delivery_confirm_by        DATETIME      NULL,
  ADD COLUMN delivered_at               DATETIME      NULL,
  ADD COLUMN delivery_confirmed_by      ENUM('customer','auto','admin') NULL;

ALTER TABLE shipments ADD KEY idx_shipments_delivery_due (status, delivery_confirm_by);

-- ---------------------------------------------------------------------
-- 3. Shipment timeline (what the customer and admin see as dots).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment_events (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  shipment_id   INT          NOT NULL,
  status        VARCHAR(30)  NOT NULL,
  note          VARCHAR(500) NULL,
  actor_role    VARCHAR(20)  NOT NULL,   -- customer | admin | technician | system
  actor_user_id INT          NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shipment_events_shipment (shipment_id, created_at)
);

-- Seed a first event for shipments that already exist, so their
-- timeline isn't empty.
INSERT INTO shipment_events (shipment_id, status, note, actor_role, created_at)
SELECT s.id, s.status, 'Status before the timeline was introduced.', 'system', s.created_at
  FROM shipments s
 WHERE NOT EXISTS (SELECT 1 FROM shipment_events e WHERE e.shipment_id = s.id);

-- ---------------------------------------------------------------------
-- 4. Pricing engine (edited from the admin Pricing page).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_support_types (
  id         VARCHAR(20)   PRIMARY KEY,
  title      VARCHAR(60)   NOT NULL,
  amount     DECIMAL(12,2) NOT NULL,
  updated_by INT           NULL,
  updated_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispatch_zones (
  id          VARCHAR(40)   PRIMARY KEY,
  name        VARCHAR(80)   NOT NULL,
  group_name  VARCHAR(40)   NOT NULL,
  distance_km DECIMAL(6,1)  NOT NULL,
  fee         DECIMAL(12,2) NOT NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order  INT           NOT NULL DEFAULT 0,
  updated_by  INT           NULL,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pricing_settings (
  setting_key   VARCHAR(40) PRIMARY KEY,
  setting_value VARCHAR(40) NOT NULL,
  updated_by    INT         NULL,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Launch prices (same as config/pricing.js). INSERT IGNORE keeps any
-- prices an admin has already set.
INSERT IGNORE INTO pricing_support_types (id, title, amount) VALUES
  ('voice', 'Voice Call', 5000),
  ('video', 'Video Call', 7000),
  ('remote', 'Remote Support', 10000);

INSERT IGNORE INTO dispatch_zones (id, name, group_name, distance_km, fee, sort_order) VALUES
  ('wuse', 'Wuse (Zones 1–7) / Wuse 2', 'City centre', 2, 1500, 0),
  ('cbd', 'Central Business District', 'City centre', 3, 1500, 1),
  ('maitama', 'Maitama', 'City centre', 4, 2000, 2),
  ('utako', 'Utako / Jabi', 'City centre', 5, 2000, 3),
  ('garki', 'Garki (Areas 1–11)', 'City centre', 5, 2000, 4),
  ('wuye', 'Wuye', 'City centre', 5, 2000, 5),
  ('mabushi', 'Mabushi / Katampe', 'City centre', 7, 2500, 6),
  ('asokoro', 'Asokoro', 'City centre', 8, 2500, 7),
  ('kado', 'Kado', 'Inner districts', 8, 2500, 8),
  ('jahi', 'Jahi', 'Inner districts', 9, 2500, 9),
  ('durumi', 'Durumi', 'Inner districts', 9, 2500, 10),
  ('gudu', 'Gudu', 'Inner districts', 10, 2500, 11),
  ('life_camp', 'Life Camp', 'Inner districts', 11, 3000, 12),
  ('karmo', 'Karmo', 'Inner districts', 12, 3000, 13),
  ('apo', 'Apo', 'Inner districts', 13, 3000, 14),
  ('galadimawa', 'Galadimawa', 'Inner districts', 14, 3500, 15),
  ('gwarinpa', 'Gwarinpa', 'Inner districts', 15, 3500, 16),
  ('lokogoma', 'Lokogoma', 'Inner districts', 15, 3500, 17),
  ('idu', 'Idu', 'Inner districts', 15, 3500, 18),
  ('dawaki', 'Dawaki', 'Satellite towns', 17, 4000, 19),
  ('karu', 'Karu', 'Satellite towns', 17, 4000, 20),
  ('lugbe', 'Lugbe', 'Satellite towns', 18, 4000, 21),
  ('dutse', 'Dutse', 'Satellite towns', 18, 4000, 22),
  ('nyanya', 'Nyanya', 'Satellite towns', 20, 4000, 23),
  ('kubwa', 'Kubwa', 'Satellite towns', 22, 4500, 24),
  ('mararaba', 'Mararaba', 'Satellite towns', 24, 5000, 25),
  ('bwari', 'Bwari', 'Satellite towns', 38, 7000, 26),
  ('kuje', 'Kuje', 'Satellite towns', 45, 8000, 27),
  ('gwagwalada', 'Gwagwalada', 'Satellite towns', 50, 8500, 28);

INSERT IGNORE INTO pricing_settings (setting_key, setting_value) VALUES
  ('base_fee', '1000'),
  ('per_km', '150'),
  ('min_fee', '1500'),
  ('round_to', '500'),
  ('delivery_confirm_hours', '12'),
  ('charge_return_on_decline', '1');
