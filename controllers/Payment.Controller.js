const {
  PaymentError,
  STATUSES,
  createPaymentIntent,
  findByReference,
  handleWebhookEvent,
  isValidWebhookSignature,
} = require("../services/paymentService");
const {
  getDispatchZone,
  getSupportType,
  getSettings,
} = require("../services/pricingService");
const { ownsShipment } = require("../services/shipmentLifecycle");
const { validateSlot } = require("../utils/schedule");
const db = require("../config/db");

function sendPaymentError(res, err, fallbackMessage) {
  if (err instanceof PaymentError || err.name === "PaymentError") {
    return res.status(err.status).json({ message: err.message, code: err.code });
  }
  console.error(fallbackMessage, err);
  return res.status(500).json({ message: "Internal Server Error" });
}

/* ===========================
   INITIALISE PAYMENT
   POST /api/payments/initialize
   Body (booking):  { purpose: "booking", support_type, booking_date, booking_time }
   Body (shipment): { purpose: "shipment", zone, pickup_date, pickup_time }

   The amount is computed here from config/pricing.js. The client gets
   back the reference + amount to open the Paystack popup with.
=========================== */
exports.initializePayment = async (req, res) => {
  try {
    const { purpose } = req.body || {};

    if (purpose === "booking") {
      const { support_type, booking_date, booking_time } = req.body;
      const type = await getSupportType(support_type);

      if (!type) {
        return res.status(400).json({ message: "Invalid support_type." });
      }

      const slot = validateSlot(booking_date, booking_time, "booking");
      if (!slot.ok) {
        return res.status(400).json({ message: slot.message });
      }

      const intent = await createPaymentIntent({
        userId: req.user.id,
        email: req.user.email,
        purpose: "booking",
        amountNaira: type.amount,
        metadata: {
          support_type: type.id,
          booking_date: slot.date,
          booking_time: slot.time,
        },
      });

      return res.status(201).json(intent);
    }

    if (purpose === "shipment") {
      const { zone, pickup_date, pickup_time } = req.body;
      const dispatchZone = await getDispatchZone(zone);

      if (!dispatchZone) {
        return res
          .status(400)
          .json({ message: "Please choose a valid pickup area in Abuja." });
      }

      const slot = validateSlot(pickup_date, pickup_time, "pickup");
      if (!slot.ok) {
        return res.status(400).json({ message: slot.message });
      }

      const intent = await createPaymentIntent({
        userId: req.user.id,
        email: req.user.email,
        purpose: "shipment",
        amountNaira: dispatchZone.fee,
        metadata: {
          zone: dispatchZone.id,
          pickup_date: slot.date,
          pickup_time: slot.time,
        },
      });

      return res.status(201).json(intent);
    }

    // Repair quote answers: "repair" (approve: repair + return delivery)
    // or "return" (decline: return delivery only). Amounts come from the
    // quote stored on the shipment, never from the client.
    if (purpose === "repair" || purpose === "return") {
      const shipmentId = Number(req.body.shipment_id);
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        return res.status(400).json({ message: "shipment_id is required." });
      }

      const [rows] = await db.query("SELECT * FROM shipments WHERE id = ?", [shipmentId]);
      const shipment = rows[0];

      if (!shipment) {
        return res.status(404).json({ message: "Shipment not found." });
      }

      if (!ownsShipment(shipment, req.user)) {
        return res
          .status(403)
          .json({ message: "You do not have permission to pay for this shipment." });
      }

      if (shipment.status !== "waiting_approval" || shipment.approval_status !== "pending") {
        return res
          .status(409)
          .json({ message: "There's no open repair quote on this shipment." });
      }

      if (purpose === "return" && !(await getSettings()).charge_return_on_decline) {
        return res
          .status(400)
          .json({ message: "No payment is needed to decline this repair." });
      }

      const amountNaira =
        purpose === "repair"
          ? Number(shipment.repair_cost) + Number(shipment.return_fee)
          : Number(shipment.return_fee);

      if (!(amountNaira > 0)) {
        return res.status(409).json({ message: "This quote has no amount to pay." });
      }

      const intent = await createPaymentIntent({
        userId: req.user.id,
        email: req.user.email,
        purpose,
        amountNaira,
        // The amount is bound to the quote: if the admin re-quotes while
        // the customer is paying, the old payment can't be applied.
        metadata: { shipment_id: String(shipment.id), quote_amount: String(amountNaira) },
      });

      return res.status(201).json(intent);
    }

    return res.status(400).json({
      message: 'purpose must be "booking", "shipment", "repair" or "return".',
    });
  } catch (err) {
    return sendPaymentError(res, err, "Initialize payment error:");
  }
};

/* ===========================
   GET PAYMENT STATUS
   GET /api/payments/:reference — owner or admin.
=========================== */
exports.getPayment = async (req, res) => {
  try {
    const tx = await findByReference(req.params.reference);

    if (!tx) {
      return res.status(404).json({ message: "Payment not found." });
    }

    if (req.user.role !== "admin" && Number(tx.user_id) !== Number(req.user.id)) {
      return res
        .status(403)
        .json({ message: "You do not have permission to view this payment." });
    }

    return res.json({
      reference: tx.reference,
      purpose: tx.purpose,
      status: tx.status,
      amount: Number(tx.amount_kobo) / 100,
      currency: tx.currency,
      entity_type: tx.entity_type,
      entity_id: tx.entity_id,
      created_at: tx.created_at,
      paid_at: tx.paid_at,
    });
  } catch (err) {
    return sendPaymentError(res, err, "Get payment error:");
  }
};

/* ===========================
   LIST PAYMENTS (admin)
   GET /api/payments?status=success&unfulfilled=true
   "success + unfulfilled" = customer paid but no booking/shipment was
   created (e.g. their browser closed) — the list to follow up on.
=========================== */
exports.listPayments = async (req, res) => {
  try {
    const conditions = [];
    const params = [];

    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ message: "Invalid status filter." });
      }
      conditions.push("status = ?");
      params.push(req.query.status);
    }

    if (req.query.unfulfilled === "true") {
      conditions.push("entity_id IS NULL");
    }

    let sql = "SELECT * FROM payment_transactions";
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC LIMIT 200";

    const [rows] = await db.query(sql, params);
    return res.json(rows);
  } catch (err) {
    return sendPaymentError(res, err, "List payments error:");
  }
};

/* ===========================
   GET PAYMENT AUDIT TRAIL (admin)
=========================== */
exports.getPaymentEvents = async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM payment_events WHERE reference = ? ORDER BY id ASC",
      [req.params.reference],
    );
    return res.json(rows);
  } catch (err) {
    return sendPaymentError(res, err, "Payment events error:");
  }
};

/* ===========================
   PAYSTACK WEBHOOK
   POST /api/payments/webhook
   Authenticated by the HMAC-SHA512 signature Paystack sends, not by a
   session. Always answers 200 for a valid signature (Paystack retries
   anything else), and is idempotent for repeated deliveries.
=========================== */
exports.paystackWebhook = async (req, res) => {
  const signature = req.headers["x-paystack-signature"];

  if (!isValidWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ message: "Invalid signature." });
  }

  try {
    const outcome = await handleWebhookEvent(req.body);
    console.info(`Paystack webhook ${req.body?.event}: ${outcome}`);
    return res.status(200).json({ received: true, outcome });
  } catch (err) {
    // A 500 makes Paystack retry later, which is what we want if our DB
    // was briefly unavailable.
    console.error("Paystack webhook error:", err);
    return res.status(500).json({ message: "Webhook processing failed." });
  }
};

exports.sendPaymentError = sendPaymentError;
