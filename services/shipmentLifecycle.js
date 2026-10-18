/* ===========================
   SHIPMENT LIFECYCLE
   pickup_scheduled → courier_assigned → device_collected → diagnosis
     → waiting_approval (admin sends a diagnosis + quote)
         ├─ approved  (customer paid repair + return delivery) → repair → quality_check → ready_for_delivery
         └─ declined  (customer paid return delivery, if policy says so) ───────────────→ ready_for_delivery
     → delivered (customer taps "I've received it", or automatically after the confirmation window)

   Every change is recorded in `shipment_events` (the customer's and
   admin's timeline), produces in-app notifications for the customer and
   admins, and — only at the moments agreed — an email:
     customer: pickup scheduled, quote ready (waiting for approval), ready for delivery
     admin:    shipment initiated, repair approved/declined, auto-confirmed delivery
=========================== */

const db = require("../config/db");
const createNotification = require("./notificationService");
const sendMail = require("./mailService");
const escapeHtml = require("../utils/escapeHtml");

const STATUS_FLOW = [
  "pickup_scheduled",
  "courier_assigned",
  "device_collected",
  "diagnosis",
  "waiting_approval",
  "repair",
  "quality_check",
  "ready_for_delivery",
  "delivered",
];

const STATUS_LABELS = {
  pickup_scheduled: "Pickup scheduled",
  courier_assigned: "Courier assigned",
  device_collected: "Device collected",
  diagnosis: "Diagnosis",
  waiting_approval: "Waiting for approval",
  repair: "Repair",
  quality_check: "Quality check",
  ready_for_delivery: "Ready for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

// What the customer is told at each step (in-app notification).
const CUSTOMER_MESSAGES = {
  pickup_scheduled: (s) => `Your pickup ${s.reference} is booked. We'll let you know when a courier is on the way.`,
  courier_assigned: (s) => `A courier has been assigned to collect your ${s.device} (${s.reference}).`,
  device_collected: (s) => `We've collected your ${s.device} and it's on its way to our Wuse workshop.`,
  diagnosis: (s) => `Our technicians are diagnosing your ${s.device}.`,
  waiting_approval: (s) =>
    `Your repair quote for ${s.reference} is ready: ₦${Number(s.quote_total).toLocaleString()}. Approve or decline it in Shipments.`,
  repair: (s) => `Repair has started on your ${s.device}.`,
  quality_check: (s) => `Your ${s.device} is in final quality checks.`,
  ready_for_delivery: (s) =>
    `Your ${s.device} is on its way back to you. Tap "I've received my device" when it arrives.`,
  delivered: (s) => `${s.reference} is complete. Thanks for using Fixer!`,
  cancelled: (s) => `Your pickup ${s.reference} has been cancelled.`,
};

/** Which statuses staff can move a shipment to next. */
function nextStatuses(shipment) {
  switch (shipment.status) {
    case "pickup_scheduled":
      return ["courier_assigned", "cancelled"];
    case "courier_assigned":
      return ["device_collected", "cancelled"];
    case "device_collected":
      return ["diagnosis"];
    case "waiting_approval":
      if (shipment.approval_status === "approved") return ["repair"];
      if (shipment.approval_status === "declined") return ["ready_for_delivery"];
      return [];
    case "repair":
      // Only after the assigned technician reports back.
      if (shipment.repair_outcome === "repaired") return ["quality_check"];
      if (shipment.repair_outcome === "unrepairable") return ["ready_for_delivery"];
      return [];
    case "quality_check":
      return ["ready_for_delivery"];
    case "ready_for_delivery":
      return ["delivered"];
    default:
      return []; // diagnosis: use the quote form; delivered/cancelled: closed
  }
}

function nextActions(shipment) {
  const awaitingCustomer =
    shipment.status === "waiting_approval" &&
    (!shipment.approval_status || shipment.approval_status === "pending");
  const statuses = nextStatuses(shipment);
  return {
    statuses,
    can_quote: shipment.status === "diagnosis" || awaitingCustomer,
    awaiting_customer: awaitingCustomer,
    // Starting the repair means choosing a technician.
    needs_technician: statuses.includes("repair"),
    awaiting_technician: shipment.status === "repair" && !shipment.repair_outcome,
  };
}

function decorate(shipment) {
  return {
    ...shipment,
    status_label: STATUS_LABELS[shipment.status] || shipment.status,
    next_actions: nextActions(shipment),
  };
}

function ownsShipment(shipment, user) {
  if (!shipment || !user) return false;
  if (shipment.user_id && Number(shipment.user_id) === Number(user.id)) return true;
  return (
    !!shipment.email &&
    String(shipment.email).toLowerCase() === String(user.email || "").toLowerCase()
  );
}

async function recordEvent(executor, { shipmentId, status, note = null, actorRole, actorUserId = null }) {
  await executor.query(
    `INSERT INTO shipment_events (shipment_id, status, note, actor_role, actor_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    [shipmentId, status, note ? String(note).slice(0, 500) : null, actorRole, actorUserId],
  );
}

async function getEvents(shipmentIds) {
  if (!shipmentIds.length) return [];
  try {
    const [rows] = await db.query(
      `SELECT id, shipment_id, status, note, actor_role, created_at
         FROM shipment_events
        WHERE shipment_id IN (${shipmentIds.map(() => "?").join(",")})
        ORDER BY created_at ASC, id ASC`,
      shipmentIds,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return [];
    throw err;
  }
}

/**
 * In-app notifications for a shipment event: the customer (if the
 * shipment is linked to an account) and all admins. Never throws —
 * the status change has already been committed.
 */
async function notify(shipment, status, { customerMessage, adminTitle, adminMessage } = {}) {
  const label = STATUS_LABELS[status] || status;
  const toCustomer = customerMessage || CUSTOMER_MESSAGES[status]?.(shipment);

  try {
    if (shipment.user_id && toCustomer) {
      await createNotification({
        user_id: shipment.user_id,
        role: "customer",
        type: "shipment",
        title: label,
        message: toCustomer,
        reference_id: shipment.id,
        reference_type: "shipment",
      });
    }

    await createNotification({
      role: "admin",
      type: "shipment",
      title: adminTitle || `${shipment.reference}: ${label}`,
      message: adminMessage || `${shipment.name}'s ${shipment.brand || ""} ${shipment.device} is now "${label}".`.replace(/\s+/g, " "),
      reference_id: shipment.id,
      reference_type: "shipment",
    });
  } catch (err) {
    console.error(`Shipment ${shipment.id} notification failed:`, err.message);
  }
}

async function safeMail(message, sender) {
  try {
    await sendMail(message, sender);
  } catch (err) {
    console.error("Shipment email failed:", err.message);
  }
}

const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

/* ---------------- Emails (only the agreed ones) ---------------- */

function emailCustomerQuote(shipment) {
  return safeMail(
    {
      to: shipment.email,
      subject: `Your repair quote for ${shipment.reference}`,
      html: `
        <p>Hi ${escapeHtml(shipment.name)},</p>
        <p>We've diagnosed your ${escapeHtml(shipment.brand)} ${escapeHtml(shipment.device)}.</p>
        <p><strong>What we found:</strong><br/>${escapeHtml(shipment.diagnosis_summary).replace(/\n/g, "<br/>")}</p>
        <p><strong>Repair:</strong> ${naira(shipment.repair_cost)}<br/>
           <strong>Return delivery:</strong> ${naira(shipment.return_fee)}<br/>
           <strong>Total:</strong> ${naira(shipment.quote_total)}</p>
        <p>Log in to Fixer and open <em>Shipments</em> to approve and pay, or decline.</p>
        <p>Thank you,<br/>Fixer Support</p>`,
    },
    "support",
  );
}

function emailCustomerReady(shipment, hours) {
  return safeMail(
    {
      to: shipment.email,
      subject: `Your device is on its way back (${shipment.reference})`,
      html: `
        <p>Hi ${escapeHtml(shipment.name)},</p>
        <p>Your ${escapeHtml(shipment.brand)} ${escapeHtml(shipment.device)} is ready and on its way back to you.</p>
        <p>When it arrives, please open <em>Shipments</em> in your Fixer account and tap
           <strong>"I've received my device"</strong>. If we don't hear from you within
           ${hours} hours, the delivery will be confirmed automatically.</p>
        <p>Thank you,<br/>Fixer Support</p>`,
    },
    "support",
  );
}

function emailAdmin(subject, html) {
  if (!process.env.ADMIN_EMAIL) return Promise.resolve();
  return safeMail({ to: process.env.ADMIN_EMAIL, subject, html }, "admin");
}

/* ---------------- Auto-confirm deliveries ---------------- */

/**
 * Marks every shipment whose confirmation window has passed as
 * delivered. Safe to run repeatedly and from several places (the
 * UPDATE only succeeds while the row is still ready_for_delivery).
 * Returns the number of shipments confirmed.
 */
async function autoConfirmDueDeliveries() {
  let due;
  try {
    [due] = await db.query(
      `SELECT * FROM shipments
        WHERE status = 'ready_for_delivery'
          AND delivery_confirm_by IS NOT NULL
          AND delivery_confirm_by <= NOW()
        LIMIT 100`,
    );
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR" || err.code === "ER_NO_SUCH_TABLE") return 0;
    throw err;
  }

  let confirmed = 0;
  for (const shipment of due || []) {
    const [result] = await db.query(
      `UPDATE shipments
          SET status = 'delivered', delivered_at = NOW(), delivery_confirmed_by = 'auto'
        WHERE id = ? AND status = 'ready_for_delivery'`,
      [shipment.id],
    );
    if (!result || result.affectedRows === 0) continue;
    confirmed += 1;

    await recordEvent(db, {
      shipmentId: shipment.id,
      status: "delivered",
      note: "Confirmed automatically — the customer didn't confirm in time.",
      actorRole: "system",
    });

    await notify(shipment, "delivered", {
      adminTitle: `${shipment.reference}: delivered (auto-confirmed)`,
      adminMessage: `${shipment.name} didn't confirm receipt in time, so delivery was confirmed automatically.`,
    });

    await emailAdmin(
      `Delivery auto-confirmed: ${shipment.reference}`,
      `<p>${escapeHtml(shipment.name)} didn't confirm receipt of their ${escapeHtml(shipment.device)}
       within the confirmation window, so ${shipment.reference} was marked delivered automatically.</p>`,
    );
  }
  return confirmed;
}

let timer = null;
function startAutoConfirmJob(intervalMs = 5 * 60 * 1000) {
  if (timer) return timer;
  const run = () =>
    autoConfirmDueDeliveries().catch((err) =>
      console.error("Auto-confirm deliveries failed:", err.message),
    );
  run();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  STATUS_FLOW,
  STATUS_LABELS,
  nextStatuses,
  nextActions,
  decorate,
  ownsShipment,
  recordEvent,
  getEvents,
  notify,
  naira,
  emailCustomerQuote,
  emailCustomerReady,
  emailAdmin,
  autoConfirmDueDeliveries,
  startAutoConfirmJob,
};
