/* ===========================
   PAYMENT SERVICE
   Every naira that changes hands goes through a row in
   `payment_transactions`, created on the server BEFORE the customer
   ever sees the Paystack popup:

     1. initialise  – server computes the amount from config/pricing.js,
                      generates the reference, stores it as `pending`
                      against the logged-in user, and returns it.
     2. Paystack    – the frontend opens the popup with that reference
                      and amount. (Tampering with the popup just
                      produces a payment that won't match the row.)
     3. confirm     – when the customer submits their booking/shipment,
                      the server re-verifies the reference with Paystack
                      and checks status, currency and the exact amount
                      against the row — never against anything the
                      client sent.
     4. fulfil      – inside a single DB transaction, with the payment
                      row locked, the booking/shipment is inserted and
                      linked to the payment. A reference can therefore
                      only ever produce one booking/shipment, and a
                      retry of the same request returns the existing one
                      instead of failing or double-creating.

   Paystack's webhook (charge.success) can also move a row from pending
   to success — useful when the customer's browser closes right after
   paying. It's idempotent: replays are no-ops.

   Every status change is written to `payment_events` for auditing.
=========================== */

const crypto = require("crypto");
const db = require("../config/db");
const {
  verifyTransaction,
  PaystackUnavailableError,
} = require("./paystackService");

const STATUSES = [
  "pending",
  "success",
  "failed",
  "abandoned",
  "reversed",
  "mismatch",
];

// booking  — expert call
// shipment — device pickup fee
// repair   — approved repair quote (repair + return delivery)
// return   — declined quote (return delivery only)
const PURPOSES = ["booking", "shipment", "repair", "return"];

class PaymentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "PaymentError";
    this.status = status;
    this.code = code;
  }
}

function generateReference(purpose) {
  const prefix = { booking: "FXB", shipment: "FXS", repair: "FXR", return: "FXT" }[purpose] || "FXP";
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// Maps Paystack's transaction status onto ours.
function mapPaystackStatus(status) {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    case "reversed":
      return "reversed";
    default:
      // ongoing / pending / processing / queued
      return "pending";
  }
}

// Loaded lazily: monitor → mailService, and tests mock both.
const monitor = () => require("./monitor");

async function recordEvent(executor, event) {
  const {
    reference,
    event: name,
    fromStatus = null,
    toStatus = null,
    source = "api",
    actorUserId = null,
    detail = null,
  } = event;

  await executor.query(
    `INSERT INTO payment_events
      (reference, event, from_status, to_status, source, actor_user_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      reference,
      name,
      fromStatus,
      toStatus,
      source,
      actorUserId,
      detail ? String(detail).slice(0, 255) : null,
    ],
  );
}

/**
 * Changes a payment's status, only if it's currently `fromStatus`
 * (compare-and-set, so two concurrent verifiers / a verifier and the
 * webhook can't both "win"), and audits the change.
 */
async function transitionStatus(
  executor,
  tx,
  toStatus,
  { source, actorUserId = null, detail = null, paystack = null } = {},
) {
  if (tx.status === toStatus) return false;

  const [result] = await executor.query(
    `UPDATE payment_transactions
        SET status = ?,
            failure_reason = ?,
            paystack_transaction_id = COALESCE(?, paystack_transaction_id),
            channel = COALESCE(?, channel),
            paid_at = IF(? = 'success', COALESCE(paid_at, NOW()), paid_at)
      WHERE reference = ? AND status = ?`,
    [
      toStatus,
      toStatus === "success" ? null : detail,
      paystack?.id ?? null,
      paystack?.channel ?? null,
      toStatus,
      tx.reference,
      tx.status,
    ],
  );

  if (result && result.affectedRows === 0) {
    // Someone else changed it first — not an error, just not ours.
    return false;
  }

  await recordEvent(executor, {
    reference: tx.reference,
    event: "status_changed",
    fromStatus: tx.status,
    toStatus,
    source,
    actorUserId,
    detail,
  });

  return true;
}

/* ---------------------------------------------------------------
   1. INITIALISE
--------------------------------------------------------------- */
async function createPaymentIntent({
  userId,
  email,
  purpose,
  amountNaira,
  metadata,
}) {
  if (!PURPOSES.includes(purpose)) {
    throw new PaymentError(400, "Invalid payment purpose.", "INVALID_PURPOSE");
  }

  const reference = generateReference(purpose);
  const amountKobo = Math.round(amountNaira * 100);

  await db.query(
    `INSERT INTO payment_transactions
      (reference, user_id, email, purpose, amount_kobo, currency, status, metadata)
     VALUES (?, ?, ?, ?, ?, 'NGN', 'pending', ?)`,
    [
      reference,
      userId,
      email,
      purpose,
      amountKobo,
      JSON.stringify(metadata || {}),
    ],
  );

  await recordEvent(db, {
    reference,
    event: "created",
    toStatus: "pending",
    source: "api",
    actorUserId: userId,
    detail: `${purpose} ${amountKobo} kobo`,
  });

  return {
    reference,
    amount: amountNaira,
    amount_kobo: amountKobo,
    currency: "NGN",
    email,
    purpose,
  };
}

async function findByReference(reference, executor = db) {
  const [rows] = await executor.query(
    "SELECT * FROM payment_transactions WHERE reference = ?",
    [reference],
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------
   2/3. CONFIRM — make sure the payment is genuinely paid
   Returns the (now `success`) transaction row, or throws PaymentError.
--------------------------------------------------------------- */
async function confirmPayment({ reference, userId, purpose, details = {} }) {
  if (typeof reference !== "string" || !reference.trim()) {
    throw new PaymentError(400, "payment_reference is required.", "MISSING_REFERENCE");
  }

  const tx = await findByReference(reference.trim());

  if (!tx) {
    throw new PaymentError(
      404,
      "We couldn't find that payment. Please start the payment again.",
      "UNKNOWN_REFERENCE",
    );
  }

  // A customer can never redeem someone else's payment, even if they
  // somehow learn the reference.
  if (Number(tx.user_id) !== Number(userId)) {
    throw new PaymentError(
      403,
      "This payment does not belong to your account.",
      "NOT_OWNER",
    );
  }

  if (tx.purpose !== purpose) {
    throw new PaymentError(
      400,
      `This payment was made for a ${tx.purpose}, not a ${purpose}.`,
      "WRONG_PURPOSE",
    );
  }

  // The payment was priced for a specific slot/zone/support type —
  // swapping those after paying (e.g. paying for Garki then submitting
  // Gwagwalada) is refused.
  const meta = parseMetadata(tx.metadata);
  const mismatched = Object.keys(meta).filter(
    (key) => details[key] !== undefined && String(details[key]) !== String(meta[key]),
  );
  if (mismatched.length) {
    throw new PaymentError(
      409,
      `Your booking details changed after payment (${mismatched.join(", ")}). Please submit the details you paid for.`,
      "DETAILS_CHANGED",
    );
  }

  if (tx.status === "success") return tx;

  let data;
  try {
    data = await verifyTransaction(tx.reference);
  } catch (err) {
    if (err instanceof PaystackUnavailableError || err.name === "PaystackUnavailableError") {
      // Leave it pending — this isn't the customer's fault and a retry
      // (or the webhook) will settle it.
      await recordEvent(db, {
        reference: tx.reference,
        event: "verify_unavailable",
        fromStatus: tx.status,
        toStatus: tx.status,
        source: "verify",
        actorUserId: userId,
        detail: err.message,
      });
      throw new PaymentError(
        503,
        "We couldn't confirm your payment with Paystack just now. Please try again in a moment — you won't be charged twice.",
        "PAYSTACK_UNAVAILABLE",
      );
    }

    // Paystack has no completed transaction for this reference — the
    // popup was probably closed before paying.
    throw new PaymentError(
      402,
      "Payment has not been completed for this reference.",
      "NOT_PAID",
    );
  }

  let newStatus = mapPaystackStatus(data.status);
  let reason = null;

  if (newStatus === "success") {
    if (data.currency !== tx.currency) {
      newStatus = "mismatch";
      reason = `currency ${data.currency} != ${tx.currency}`;
    } else if (Number(data.amount) !== Number(tx.amount_kobo)) {
      newStatus = "mismatch";
      reason = `amount ${data.amount} != ${tx.amount_kobo}`;
    }
  } else {
    reason = `paystack status: ${data.status}`;
  }

  const changedByVerify = await transitionStatus(db, tx, newStatus, {
    source: "verify",
    actorUserId: userId,
    detail: reason,
    paystack: data,
  });

  if (changedByVerify && newStatus === "mismatch") {
    monitor().paymentAlert("mismatch", { reference: tx.reference, reason, source: "verify", user_id: tx.user_id });
  }

  if (newStatus === "success") {
    return { ...tx, status: "success" };
  }

  const messages = {
    pending: "Your payment is still processing. Please try again in a moment.",
    failed: "Your payment failed. You have not been charged.",
    abandoned: "The payment was not completed.",
    reversed: "This payment has been reversed.",
    mismatch:
      "The amount paid doesn't match the price for this request. Please contact support with your payment reference.",
  };

  throw new PaymentError(
    newStatus === "pending" ? 409 : 402,
    `Payment could not be verified: ${messages[newStatus]}`,
    `PAYMENT_${newStatus.toUpperCase()}`,
  );
}

/* ---------------------------------------------------------------
   4. FULFIL — create the booking/shipment exactly once
   `create(connection)` must insert the entity using the provided
   connection (so it's inside the transaction) and return its id.
   Returns { entityId, alreadyFulfilled }.
--------------------------------------------------------------- */
async function fulfillPayment({ reference, entityType, actorUserId, create }) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT reference, status, entity_type, entity_id
         FROM payment_transactions
        WHERE reference = ?
        FOR UPDATE`,
      [reference],
    );
    const locked = rows[0];

    if (!locked || locked.status !== "success") {
      await connection.rollback();
      throw new PaymentError(402, "Payment is not confirmed.", "NOT_PAID");
    }

    if (locked.entity_id) {
      // Already redeemed — a retry or a double-click. Hand back the
      // existing record rather than creating a second one.
      await connection.rollback();
      return { entityId: locked.entity_id, alreadyFulfilled: true };
    }

    const entityId = await create(connection);

    await connection.query(
      `UPDATE payment_transactions
          SET entity_type = ?, entity_id = ?, fulfilled_at = NOW()
        WHERE reference = ?`,
      [entityType, entityId, reference],
    );

    await recordEvent(connection, {
      reference,
      event: "fulfilled",
      fromStatus: "success",
      toStatus: "success",
      source: "api",
      actorUserId,
      detail: `${entityType} #${entityId}`,
    });

    await connection.commit();
    return { entityId, alreadyFulfilled: false };
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* already rolled back */
    }
    // The customer has paid but nothing was created — someone needs to
    // follow up (refund or apply it by hand).
    if (err.code !== "NOT_PAID") {
      monitor().paymentAlert("unapplied", {
        reference,
        entity_type: entityType,
        reason: err.code || err.message,
      });
    }
    throw err;
  } finally {
    connection.release();
  }
}

/* ---------------------------------------------------------------
   WEBHOOK
--------------------------------------------------------------- */
function isValidWebhookSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !rawBody || typeof signature !== "string") return false;

  const expected = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Applies a (signature-verified) Paystack event. Safe to call any
 * number of times with the same event.
 * Returns a short string describing what happened (for logs/tests).
 */
async function handleWebhookEvent(payload) {
  const eventName = payload?.event;
  const data = payload?.data || {};

  if (eventName !== "charge.success") return "ignored_event";
  if (!data.reference) return "missing_reference";

  const tx = await findByReference(data.reference);
  if (!tx) return "unknown_reference";

  if (tx.status === "success") return "already_success";

  let newStatus = "success";
  let reason = null;

  if (data.currency !== tx.currency) {
    newStatus = "mismatch";
    reason = `currency ${data.currency} != ${tx.currency}`;
  } else if (Number(data.amount) !== Number(tx.amount_kobo)) {
    newStatus = "mismatch";
    reason = `amount ${data.amount} != ${tx.amount_kobo}`;
  }

  const changed = await transitionStatus(db, tx, newStatus, {
    source: "webhook",
    detail: reason,
    paystack: data,
  });

  if (changed && newStatus === "mismatch") {
    monitor().paymentAlert("mismatch", { reference: tx.reference, reason, source: "webhook", user_id: tx.user_id });
  }

  return changed ? `marked_${newStatus}` : "no_change";
}

module.exports = {
  STATUSES,
  PaymentError,
  createPaymentIntent,
  confirmPayment,
  fulfillPayment,
  findByReference,
  handleWebhookEvent,
  isValidWebhookSignature,
  mapPaystackStatus,
};
