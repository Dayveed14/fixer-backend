-- Reverses 2026-10-18c. Loses: meeting links on bookings, and which
-- technician repaired each shipment (with their notes).
-- Roll the app back to a build from before 2026-10-18c FIRST.
ALTER TABLE shipments DROP KEY idx_shipments_technician;

ALTER TABLE shipments
  DROP COLUMN repaired_at,
  DROP COLUMN repair_note,
  DROP COLUMN repair_outcome,
  DROP COLUMN technician_id;

ALTER TABLE bookings
  DROP COLUMN meeting_provider,
  DROP COLUMN meeting_url;
