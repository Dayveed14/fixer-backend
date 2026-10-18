-- =====================================================================
-- Fixer migration — 2026-10-18 (part 3): technician repairs + meeting links
-- Run AFTER 2026-10-18b_repair_lifecycle_pricing.sql. Back up first.
-- =====================================================================

-- Video-call meeting link, created when the booking is paid.
ALTER TABLE bookings
  ADD COLUMN meeting_url      VARCHAR(255) NULL,
  ADD COLUMN meeting_provider VARCHAR(20)  NULL;   -- google_meet | jitsi

-- Repairs are assigned to a technician, who reports the result.
ALTER TABLE shipments
  ADD COLUMN technician_id  INT          NULL,
  ADD COLUMN repair_outcome ENUM('repaired', 'unrepairable') NULL,
  ADD COLUMN repair_note    VARCHAR(500) NULL,
  ADD COLUMN repaired_at    DATETIME     NULL;

ALTER TABLE shipments ADD KEY idx_shipments_technician (technician_id, status);

-- Shipments already in repair before this change were done without a
-- technician report; mark them repaired so the admin can move them on.
UPDATE shipments
   SET repair_outcome = 'repaired', repaired_at = NOW()
 WHERE status IN ('repair') AND repair_outcome IS NULL AND technician_id IS NULL;
