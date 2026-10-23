const db = require("../config/db");
const {
  confirmPayment,
  fulfillPayment,
  PaymentError,
} = require("../services/paymentService");
const { sendPaymentError } = require("./Payment.Controller");
const pricing = require("../services/pricingService");
const { REPAIR_OFFICE } = require("../config/pricing");
const lifecycle = require("../services/shipmentLifecycle");
const {
  availableSlots,
  allSlots,
  normalizeTime,
  parseDate,
  LEAD_MINUTES,
} = require("../utils/schedule");
const escapeHtml = require("../utils/escapeHtml");
const sendMail = require("../services/mailService");
const createNotification = require("../services/notificationService");

const { STATUS_LABELS, decorate, ownsShipment, recordEvent, notify, naira } = lifecycle;

const SHIPMENT_STATUSES = [...lifecycle.STATUS_FLOW, "cancelled"];

const FIELD_LIMITS = {
  name: 120,
  email: 160,
  phone: 30,
  device: 60,
  brand: 120,
  fault: 500,
  address: 300,
  notes: 1000,
};

const QUOTE_LIMITS = { diagnosis: 2000, maxCost: 5000000 };

function handleError(res, error, label) {
  if (error.name === "PaymentError") return sendPaymentError(res, error);
  console.error(label, error);
  if (error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ message: "This payment has already been used." });
  }
  return res.status(500).json({ message: "Internal Server Error" });
}

// What declining the open quote would cost the customer (0 when the
// admin has switched the return-fee-on-decline policy off).
function withDeclineFee(shipment, settings) {
  return {
    ...shipment,
    decline_fee: settings.charge_return_on_decline ? Number(shipment.return_fee) || 0 : 0,
  };
}

async function findShipment(idOrReference) {
  const [rows] = await db.query(
    "SELECT * FROM shipments WHERE id = ? OR reference = ?",
    [idOrReference, idOrReference],
  );
  return rows[0] || null;
}

/* ===========================
   DISPATCH ZONES (public) — GET /api/shipments/zones
   Active zones from the pricing engine (admin Pricing page).
=========================== */
exports.getZones = async (req, res) => {
  try {
    const [zones, settings] = await Promise.all([
      pricing.getActiveZones(),
      pricing.getSettings(),
    ]);
    res.json({
      office: REPAIR_OFFICE,
      currency: "NGN",
      rate_card: {
        base_fee: settings.base_fee,
        per_km: settings.per_km,
        minimum_fee: settings.min_fee,
      },
      zones: zones.map(({ id, name, group, distanceKm, fee }) => ({
        id,
        name,
        group,
        distanceKm,
        fee,
      })),
    });
  } catch (err) {
    handleError(res, err, "Get zones error:");
  }
};

/* ===========================
   PICKUP SLOTS (public) — GET /api/shipments/slots?date=YYYY-MM-DD
=========================== */
exports.getPickupSlots = (req, res) => {
  const { date } = req.query;
  if (!parseDate(date)) {
    return res.status(400).json({ message: "date must be YYYY-MM-DD." });
  }
  return res.json({
    date,
    lead_minutes: LEAD_MINUTES.pickup,
    all: allSlots("pickup"),
    available: availableSlots(date, "pickup"),
  });
};

/* ===========================
   CREATE SHIPMENT (device pickup request)
   After paying with a reference from POST /api/payments/initialize.
=========================== */
exports.createShipment = async (req, res) => {
  try {
    const body = req.body || {};
    const {
      name,
      phone,
      device,
      brand,
      fault,
      address,
      notes,
      zone,
      pickup_date,
      pickup_time,
      payment_reference,
    } = body;
    const email = body.email || req.user.email;

    if (
      !name ||
      !phone ||
      !device ||
      !brand ||
      !fault ||
      !address ||
      !zone ||
      !pickup_date ||
      !pickup_time ||
      !payment_reference
    ) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    for (const [field, max] of Object.entries(FIELD_LIMITS)) {
      const value = field === "email" ? email : body[field];
      if (value !== undefined && value !== null && String(value).length > max) {
        return res
          .status(400)
          .json({ message: `${field} must be at most ${max} characters.` });
      }
    }

    // Zones can be deactivated after payment — look up any zone so a
    // paid pickup isn't refused; the paid amount comes from the payment.
    const dispatchZone = await pricing.getZoneById(zone);
    if (!dispatchZone) {
      return res
        .status(400)
        .json({ message: "Please choose a valid pickup area in Abuja." });
    }

    const pickupTime = normalizeTime(pickup_time);
    if (!parseDate(pickup_date) || !pickupTime) {
      return res.status(400).json({ message: "Invalid pickup date or time." });
    }

    const payment = await confirmPayment({
      reference: payment_reference,
      userId: req.user.id,
      purpose: "shipment",
      details: {
        zone: dispatchZone.id,
        pickup_date,
        pickup_time: pickupTime,
      },
    });

    const feeNaira = Number(payment.amount_kobo) / 100;
    const city = `${dispatchZone.name}, Abuja`;

    const { entityId: shipmentId, alreadyFulfilled } = await fulfillPayment({
      reference: payment.reference,
      entityType: "shipment",
      actorUserId: req.user.id,
      create: async (connection) => {
        const [result] = await connection.query(
          `
          INSERT INTO shipments
          (
            reference, user_id, name, email, phone, device, brand, fault,
            address, city, pickup_zone, notes, pickup_date, pickup_time,
            fee_amount, payment_status, payment_reference, status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'pickup_scheduled')
          `,
          [
            "PENDING",
            req.user.id,
            name,
            email,
            phone,
            device,
            brand,
            fault,
            address,
            city,
            dispatchZone.id,
            notes || null,
            pickup_date,
            pickupTime,
            feeNaira,
            payment.reference,
          ],
        );

        const id = result.insertId;
        await connection.query(
          "UPDATE shipments SET reference = ? WHERE id = ?",
          [`FXR-${1000 + id}`, id],
        );
        await recordEvent(connection, {
          shipmentId: id,
          status: "pickup_scheduled",
          note: `Pickup fee ${naira(feeNaira)} paid.`,
          actorRole: "customer",
          actorUserId: req.user.id,
        });
        return id;
      },
    });

    const reference = `FXR-${1000 + Number(shipmentId)}`;

    if (alreadyFulfilled) {
      return res.status(200).json({
        message: "Pickup already scheduled for this payment",
        id: shipmentId,
        reference,
        fee_amount: feeNaira,
        zone: dispatchZone.id,
      });
    }

    const shipment = {
      id: shipmentId,
      reference,
      user_id: req.user.id,
      name,
      email,
      device,
      brand,
    };

    await notify(shipment, "pickup_scheduled", {
      adminTitle: `New pickup: ${reference}`,
      adminMessage: `${name} paid ${naira(feeNaira)} for a ${dispatchZone.name} pickup on ${pickup_date} at ${pickupTime.slice(0, 5)}.`,
    });

    const safe = {
      name: escapeHtml(name),
      brand: escapeHtml(brand),
      device: escapeHtml(device),
      fault: escapeHtml(fault),
      address: escapeHtml(address),
      city: escapeHtml(city),
    };

    // Email 1 of 3 to the customer: pickup scheduled.
    try {
      await sendMail(
        {
          to: email,
          subject: "Your device pickup is scheduled",
          html: `
            <p>Hi ${safe.name},</p>
            <p>Your device pickup has been scheduled and payment received.</p>
            <p><strong>Reference:</strong> ${reference}</p>
            <p><strong>Device:</strong> ${safe.brand} ${safe.device}</p>
            <p><strong>Pickup:</strong> ${pickup_date} at ${pickupTime.slice(0, 5)}</p>
            <p><strong>Address:</strong> ${safe.address}, ${safe.city}</p>
            <p><strong>Pickup fee:</strong> ${naira(feeNaira)}</p>
            <p>You can follow every step in <em>Shipments</em> in your Fixer account.</p>
            <p>Thank you,<br/>Fixer Support</p>
          `,
        },
        "support",
      );
    } catch (mailError) {
      console.error("Pickup email failed:", mailError.message);
    }

    // Admin email: shipment initiated.
    await lifecycle.emailAdmin(
      `Shipment initiated: ${reference}`,
      `
        <p>${safe.name} paid for a device pickup.</p>
        <p><strong>Reference:</strong> ${reference}</p>
        <p><strong>Device:</strong> ${safe.brand} ${safe.device}</p>
        <p><strong>Fault:</strong> ${safe.fault}</p>
        <p><strong>Pickup:</strong> ${pickup_date} at ${pickupTime.slice(0, 5)}</p>
        <p><strong>Address:</strong> ${safe.address}, ${safe.city}</p>
        <p><strong>Fee:</strong> ${naira(feeNaira)} (${escapeHtml(dispatchZone.name)})</p>
      `,
    );

    return res.status(201).json({
      message: "Pickup scheduled",
      id: shipmentId,
      reference,
      fee_amount: feeNaira,
      zone: dispatchZone.id,
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This payment has already been used for a pickup request.",
      });
    }
    return handleError(res, error, "Create shipment error:");
  }
};

/* ===========================
   LIST (admin) — GET /api/shipments
=========================== */
exports.getShipments = async (req, res) => {
  try {
    const [shipments] = await db.query(
      "SELECT * FROM shipments ORDER BY created_at DESC",
    );
    res.json(shipments.map(decorate));
  } catch (err) {
    handleError(res, err, "List shipments error:");
  }
};

/* ===========================
   ONE SHIPMENT + TIMELINE — GET /api/shipments/:id (id or FXR ref)
=========================== */
exports.getShipment = async (req, res) => {
  try {
    const shipment = await findShipment(req.params.id);

    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    const assignedTechnician =
      req.user.role === "technician" &&
      Number(shipment.technician_id) === Number(req.user.id);

    if (req.user.role !== "admin" && !assignedTechnician && !ownsShipment(shipment, req.user)) {
      return res.status(403).json({
        message: "You do not have permission to view this shipment.",
      });
    }

    const [events, settings] = await Promise.all([
      lifecycle.getEvents([shipment.id]),
      pricing.getSettings(),
    ]);
    res.json({ ...withDeclineFee(decorate(shipment), settings), events });
  } catch (err) {
    handleError(res, err, "Get shipment error:");
  }
};

/* ===========================
   CUSTOMER HISTORY — GET /api/shipments/user/:email
   Each shipment comes with its timeline.
=========================== */
exports.getUserShipment = async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    if (
      req.user.role !== "admin" &&
      email.toLowerCase() !== String(req.user.email).toLowerCase()
    ) {
      return res.status(403).json({
        message: "You do not have permission to view these shipments.",
      });
    }

    const [rows] =
      req.user.role === "admin"
        ? await db.query(
            "SELECT * FROM shipments WHERE email = ? ORDER BY created_at DESC",
            [email],
          )
        : await db.query(
            "SELECT * FROM shipments WHERE user_id = ? OR email = ? ORDER BY created_at DESC",
            [req.user.id, req.user.email],
          );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No shipments found for this user." });
    }

    const [events, settings] = await Promise.all([
      lifecycle.getEvents(rows.map((r) => r.id)),
      pricing.getSettings(),
    ]);
    res.json(
      rows.map((r) => ({
        ...withDeclineFee(decorate(r), settings),
        events: events.filter((e) => Number(e.shipment_id) === Number(r.id)),
      })),
    );
  } catch (err) {
    handleError(res, err, "Get user shipments error:");
  }
};

/* ===========================
   MOVE TO NEXT STATUS (admin / technician)
   PATCH /api/shipments/:id/status  { status, note? }
   Only the next step in the lifecycle is allowed. "waiting_approval"
   is reached through the quote form, never directly.
=========================== */
exports.updateShipmentStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    const note =
      typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : null;

    if (!SHIPMENT_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${SHIPMENT_STATUSES.join(", ")}.`,
      });
    }

    if (status === "waiting_approval") {
      return res.status(400).json({
        message: "Send the diagnosis and repair quote to move a shipment to waiting for approval.",
      });
    }

    const shipment = await findShipment(req.params.id);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    const allowed = lifecycle.nextStatuses(shipment);
    if (!allowed.includes(status)) {
      let message = `A shipment that is "${STATUS_LABELS[shipment.status] || shipment.status}" can't move to "${STATUS_LABELS[status]}".`;
      if (shipment.status === "diagnosis") {
        message = "Send the diagnosis and repair quote first.";
      } else if (shipment.status === "waiting_approval" && !["approved", "declined"].includes(shipment.approval_status)) {
        message = "Waiting for the customer to approve or decline the quote.";
      } else if (shipment.status === "waiting_approval" && shipment.approval_status === "declined") {
        message = "The customer declined the repair — send the device back (Ready for delivery).";
      } else if (shipment.status === "repair" && !shipment.repair_outcome) {
        message = "Waiting for the technician to mark the device repaired.";
      } else if (shipment.status === "repair" && shipment.repair_outcome === "unrepairable") {
        message = "The technician couldn't repair it — send the device back (Ready for delivery).";
      }
      return res.status(409).json({ message, allowed });
    }

    let extra = "";
    const params = [status];
    let hours = null;
    let technician = null;

    if (status === "repair") {
      // Starting the repair = assigning it to a technician.
      const technicianId = Number(req.body?.technician_id);
      if (!Number.isInteger(technicianId) || technicianId <= 0) {
        return res.status(400).json({ message: "Choose a technician to start the repair." });
      }
      const [techRows] = await db.query(
        "SELECT id, first_name, last_name, email FROM users WHERE id = ? AND role = 'technician'",
        [technicianId],
      );
      technician = techRows[0];
      if (!technician) {
        return res.status(404).json({ message: "Technician not found." });
      }
      extra = ", technician_id = ?, repair_outcome = NULL, repair_note = NULL, repaired_at = NULL";
      params.push(technician.id);
    } else if (status === "ready_for_delivery") {
      hours = (await pricing.getSettings()).delivery_confirm_hours;
      extra = ", ready_at = NOW(), delivery_confirm_by = DATE_ADD(NOW(), INTERVAL ? HOUR)";
      params.push(hours);
    } else if (status === "delivered") {
      extra = ", delivered_at = NOW(), delivery_confirmed_by = 'admin'";
    }

    params.push(shipment.id, shipment.status);

    // Compare-and-set on the current status: two staff clicking at once
    // can't skip a step.
    const [result] = await db.query(
      `UPDATE shipments SET status = ?${extra} WHERE id = ? AND status = ?`,
      params,
    );

    if (result && result.affectedRows === 0) {
      return res.status(409).json({ message: "This shipment was just updated. Refresh and try again." });
    }

    await recordEvent(db, {
      shipmentId: shipment.id,
      status,
      note: technician
        ? [`Assigned to ${technician.first_name} ${technician.last_name}.`, note].filter(Boolean).join(" ")
        : note,
      actorRole: req.user.role,
      actorUserId: req.user.id,
    });

    const updated = { ...shipment, status, technician_id: technician ? technician.id : shipment.technician_id };
    await notify(updated, status);

    if (technician) {
      try {
        await createNotification({
          user_id: technician.id,
          role: "technician",
          type: "shipment",
          title: "New repair assigned",
          message: `${shipment.reference}: ${shipment.brand || ""} ${shipment.device} — ${shipment.diagnosis_summary || shipment.fault}`.replace(/\s+/g, " ").slice(0, 250),
          reference_id: shipment.id,
          reference_type: "shipment",
        });
      } catch (notifyError) {
        console.error("Technician notification failed:", notifyError.message);
      }
    }

    // Email 3 of 3 to the customer: ready for delivery.
    if (status === "ready_for_delivery") {
      await lifecycle.emailCustomerReady(updated, hours);
    }

    res.json({
      message: "Shipment status updated",
      status,
      next_actions: lifecycle.nextActions(updated),
    });
  } catch (err) {
    handleError(res, err, "Update shipment status error:");
  }
};

/* ===========================
   SEND DIAGNOSIS + QUOTE (admin / technician)
   POST /api/shipments/:id/quote  { diagnosis, repair_cost }
   Moves diagnosis → waiting_approval. The total adds the return
   delivery fee for the customer's area so they pay for the trip back
   up front. Can be revised while the customer hasn't answered.
=========================== */
exports.sendQuote = async (req, res) => {
  try {
    const diagnosis =
      typeof req.body?.diagnosis === "string" ? req.body.diagnosis.trim() : "";
    const repairCost = Number(req.body?.repair_cost);

    if (!diagnosis || diagnosis.length > QUOTE_LIMITS.diagnosis) {
      return res.status(400).json({
        message: `Describe what's wrong (1–${QUOTE_LIMITS.diagnosis} characters).`,
      });
    }

    if (!Number.isInteger(repairCost) || repairCost <= 0 || repairCost > QUOTE_LIMITS.maxCost) {
      return res.status(400).json({
        message: `Repair cost must be a whole number of naira between ₦1 and ₦${QUOTE_LIMITS.maxCost.toLocaleString()}.`,
      });
    }

    const shipment = await findShipment(req.params.id);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    const { can_quote: canQuote } = lifecycle.nextActions(shipment);
    if (!canQuote) {
      return res.status(409).json({
        message:
          shipment.status === "waiting_approval"
            ? "The customer has already answered this quote."
            : "Move the shipment to Diagnosis before sending a quote.",
      });
    }

    // Return delivery is charged at the customer's area's current fee
    // (falls back to what they paid for pickup).
    const zone = await pricing.getZoneById(shipment.pickup_zone);
    const returnFee = zone ? zone.fee : Number(shipment.fee_amount) || 0;
    const total = repairCost + returnFee;

    const [result] = await db.query(
      `UPDATE shipments
          SET status = 'waiting_approval',
              diagnosis_summary = ?, repair_cost = ?, return_fee = ?, quote_total = ?,
              quoted_at = NOW(), approval_status = 'pending'
        WHERE id = ? AND status = ?`,
      [diagnosis, repairCost, returnFee, total, shipment.id, shipment.status],
    );

    if (result && result.affectedRows === 0) {
      return res.status(409).json({ message: "This shipment was just updated. Refresh and try again." });
    }

    const revised = shipment.status === "waiting_approval";
    await recordEvent(db, {
      shipmentId: shipment.id,
      status: "waiting_approval",
      note: `${revised ? "Revised quote" : "Quote sent"}: repair ${naira(repairCost)} + return delivery ${naira(returnFee)} = ${naira(total)}.`,
      actorRole: req.user.role,
      actorUserId: req.user.id,
    });

    const updated = {
      ...shipment,
      status: "waiting_approval",
      diagnosis_summary: diagnosis,
      repair_cost: repairCost,
      return_fee: returnFee,
      quote_total: total,
      approval_status: "pending",
    };

    await notify(updated, "waiting_approval", {
      adminTitle: `${shipment.reference}: quote sent`,
      adminMessage: `Quote of ${naira(total)} sent to ${shipment.name}. Waiting for their approval.`,
    });

    // Email 2 of 3 to the customer: quote ready.
    await lifecycle.emailCustomerQuote(updated);

    res.json({
      message: "Quote sent to the customer",
      repair_cost: repairCost,
      return_fee: returnFee,
      quote_total: total,
    });
  } catch (err) {
    handleError(res, err, "Send quote error:");
  }
};

/* ===========================
   CUSTOMER APPROVES / DECLINES THE QUOTE
   POST /api/shipments/:id/approval  { decision: "approve" | "decline", payment_reference? }
   approve: pays repair + return delivery (payment purpose "repair")
   decline: pays return delivery (purpose "return") — unless the admin
            has switched that policy off in Pricing settings.
=========================== */
exports.respondToQuote = async (req, res) => {
  try {
    const { decision, payment_reference } = req.body || {};

    if (!["approve", "decline"].includes(decision)) {
      return res.status(400).json({ message: 'decision must be "approve" or "decline".' });
    }

    const shipment = await findShipment(req.params.id);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    if (!ownsShipment(shipment, req.user)) {
      return res.status(403).json({ message: "You do not have permission to answer this quote." });
    }

    const pending =
      shipment.status === "waiting_approval" && shipment.approval_status === "pending";

    const settings = await pricing.getSettings();
    const needsPayment = decision === "approve" || settings.charge_return_on_decline;
    const approvalStatus = decision === "approve" ? "approved" : "declined";

    let amountPaid = 0;
    let alreadyAnswered = false;

    // What this decision costs under a given quote.
    const quoteAmount = (row) =>
      decision === "approve"
        ? Number(row.repair_cost) + Number(row.return_fee)
        : Number(row.return_fee);

    const applyDecision = async (executor, paymentReference) => {
      const [rows] = await executor.query(
        "SELECT status, approval_status, repair_cost, return_fee FROM shipments WHERE id = ? FOR UPDATE",
        [shipment.id],
      );
      const locked = rows[0];
      if (!locked || locked.status !== "waiting_approval" || locked.approval_status !== "pending") {
        throw new PaymentError(409, "This quote has already been answered.", "QUOTE_ANSWERED");
      }
      // Re-checked under the lock: the quote can't change between
      // verifying the payment and applying it.
      if (paymentReference && Math.round(quoteAmount(locked) * 100) !== Math.round(amountPaid * 100)) {
        throw new PaymentError(
          409,
          "Your quote was updated after you paid. Our team has been alerted and will sort out the difference with you.",
          "QUOTE_CHANGED",
        );
      }
      await executor.query(
        `UPDATE shipments
            SET approval_status = ?, approval_at = NOW(),
                approval_payment_reference = ?, approval_amount_paid = ?
          WHERE id = ?`,
        [approvalStatus, paymentReference, amountPaid, shipment.id],
      );
      await recordEvent(executor, {
        shipmentId: shipment.id,
        status: "waiting_approval",
        note:
          decision === "approve"
            ? `Customer approved the repair and paid ${naira(amountPaid)}.`
            : amountPaid
              ? `Customer declined the repair and paid ${naira(amountPaid)} for return delivery.`
              : "Customer declined the repair.",
        actorRole: "customer",
        actorUserId: req.user.id,
      });
      return shipment.id;
    };

    if (needsPayment) {
      if (!payment_reference) {
        return res.status(400).json({ message: "payment_reference is required." });
      }

      const payment = await confirmPayment({
        reference: payment_reference,
        userId: req.user.id,
        purpose: decision === "approve" ? "repair" : "return",
        details: { shipment_id: String(shipment.id), quote_amount: String(quoteAmount(shipment)) },
      });
      amountPaid = Number(payment.amount_kobo) / 100;

      if (!pending) {
        // Retry after success: same payment already applied → fine.
        if (shipment.approval_payment_reference === payment.reference) {
          alreadyAnswered = true;
        } else {
          return res.status(409).json({ message: "This quote has already been answered." });
        }
      } else {
        const result = await fulfillPayment({
          reference: payment.reference,
          entityType: decision === "approve" ? "shipment_repair" : "shipment_return",
          actorUserId: req.user.id,
          create: (connection) => applyDecision(connection, payment.reference),
        });
        alreadyAnswered = result.alreadyFulfilled;
      }
    } else {
      if (!pending) {
        return res.status(409).json({ message: "This quote has already been answered." });
      }
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await applyDecision(connection, null);
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    }

    if (!alreadyAnswered) {
      const updated = { ...shipment, approval_status: approvalStatus };
      const safeName = escapeHtml(shipment.name);

      await notify(updated, "waiting_approval", {
        customerMessage:
          decision === "approve"
            ? `Thanks! Payment received — we'll start repairing your ${shipment.device} shortly.`
            : `You declined the repair. We'll send your ${shipment.device} back to you.`,
        adminTitle: `${shipment.reference}: repair ${approvalStatus}`,
        adminMessage:
          decision === "approve"
            ? `${shipment.name} approved the repair and paid ${naira(amountPaid)}. You can start the repair.`
            : `${shipment.name} declined the repair${amountPaid ? ` and paid ${naira(amountPaid)} for return delivery` : ""}. Send the device back.`,
      });

      await lifecycle.emailAdmin(
        `Repair ${approvalStatus}: ${shipment.reference}`,
        decision === "approve"
          ? `<p>${safeName} <strong>approved</strong> the repair for ${shipment.reference} and paid ${naira(amountPaid)} (repair + return delivery).</p><p>Move it to <em>Repair</em> in the admin dashboard.</p>`
          : `<p>${safeName} <strong>declined</strong> the repair for ${shipment.reference}${amountPaid ? ` and paid ${naira(amountPaid)} for return delivery` : ""}.</p><p>Move it to <em>Ready for delivery</em> when the device is on its way back.</p>`,
      );
    }

    return res.json({
      message:
        decision === "approve" ? "Repair approved" : "Repair declined",
      approval_status: approvalStatus,
      amount_paid: amountPaid,
    });
  } catch (err) {
    return handleError(res, err, "Quote response error:");
  }
};

/* ===========================
   CUSTOMER CONFIRMS RECEIPT
   POST /api/shipments/:id/confirm-delivery
=========================== */
exports.confirmDelivery = async (req, res) => {
  try {
    const shipment = await findShipment(req.params.id);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    if (!ownsShipment(shipment, req.user)) {
      return res.status(403).json({ message: "You do not have permission to confirm this delivery." });
    }

    if (shipment.status === "delivered") {
      return res.json({ message: "Delivery already confirmed", status: "delivered" });
    }

    if (shipment.status !== "ready_for_delivery") {
      return res.status(409).json({ message: "This shipment isn't out for delivery yet." });
    }

    const [result] = await db.query(
      `UPDATE shipments
          SET status = 'delivered', delivered_at = NOW(), delivery_confirmed_by = 'customer'
        WHERE id = ? AND status = 'ready_for_delivery'`,
      [shipment.id],
    );

    if (result && result.affectedRows === 0) {
      return res.json({ message: "Delivery already confirmed", status: "delivered" });
    }

    await recordEvent(db, {
      shipmentId: shipment.id,
      status: "delivered",
      note: "Customer confirmed they received the device.",
      actorRole: "customer",
      actorUserId: req.user.id,
    });

    await notify({ ...shipment, status: "delivered" }, "delivered", {
      adminTitle: `${shipment.reference}: delivered`,
      adminMessage: `${shipment.name} confirmed they received their ${shipment.device}.`,
    });

    return res.json({ message: "Delivery confirmed", status: "delivered" });
  } catch (err) {
    return handleError(res, err, "Confirm delivery error:");
  }
};

/* ===========================
   TECHNICIAN: MY REPAIRS — GET /api/shipments/assigned
   Shipments assigned to the logged-in technician (admins see all
   assigned shipments). Includes each shipment's timeline.
=========================== */
exports.getAssignedRepairs = async (req, res) => {
  try {
    const [rows] =
      req.user.role === "admin"
        ? await db.query(
            "SELECT * FROM shipments WHERE technician_id IS NOT NULL ORDER BY id DESC",
          )
        : await db.query(
            "SELECT * FROM shipments WHERE technician_id = ? ORDER BY id DESC",
            [req.user.id],
          );

    const events = await lifecycle.getEvents(rows.map((r) => r.id));
    res.json(
      rows.map((r) => ({
        ...decorate(r),
        events: events.filter((e) => Number(e.shipment_id) === Number(r.id)),
      })),
    );
  } catch (err) {
    handleError(res, err, "Assigned repairs error:");
  }
};

/* ===========================
   TECHNICIAN: REPORT THE REPAIR — POST /api/shipments/:id/repair-result
   { outcome: "repaired" | "unrepairable", note? }
   No amount — the admin already quoted and the customer already paid.
   Only after this can the admin move the device to quality check (or,
   if unrepairable, send it back).
=========================== */
exports.reportRepairResult = async (req, res) => {
  try {
    const { outcome } = req.body || {};
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";

    if (!["repaired", "unrepairable"].includes(outcome)) {
      return res.status(400).json({ message: 'outcome must be "repaired" or "unrepairable".' });
    }

    if (outcome === "unrepairable" && !note) {
      return res.status(400).json({ message: "Say why it can't be repaired." });
    }

    const shipment = await findShipment(req.params.id);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    if (req.user.role === "technician" && Number(shipment.technician_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: "This repair isn't assigned to you." });
    }

    if (shipment.status !== "repair") {
      return res.status(409).json({ message: "This device isn't in repair." });
    }

    if (shipment.repair_outcome) {
      return res.status(409).json({ message: "You've already reported this repair." });
    }

    const [result] = await db.query(
      `UPDATE shipments
          SET repair_outcome = ?, repair_note = ?, repaired_at = NOW()
        WHERE id = ? AND status = 'repair' AND repair_outcome IS NULL`,
      [outcome, note || null, shipment.id],
    );

    if (result && result.affectedRows === 0) {
      return res.status(409).json({ message: "This repair was just updated. Refresh and try again." });
    }

    await recordEvent(db, {
      shipmentId: shipment.id,
      status: "repair",
      note:
        outcome === "repaired"
          ? `Technician marked it repaired.${note ? ` ${note}` : ""}`
          : `Technician couldn't repair it: ${note}`,
      actorRole: req.user.role,
      actorUserId: req.user.id,
    });

    try {
      await createNotification({
        role: "admin",
        type: "shipment",
        title:
          outcome === "repaired"
            ? `${shipment.reference}: repaired`
            : `${shipment.reference}: can't be repaired`,
        message:
          outcome === "repaired"
            ? `The technician finished the repair on ${shipment.name}'s ${shipment.device}. Move it to quality check.`
            : `The technician couldn't repair ${shipment.name}'s ${shipment.device}: ${note}`,
        reference_id: shipment.id,
        reference_type: "shipment",
      });
    } catch (notifyError) {
      console.error("Admin notification failed:", notifyError.message);
    }

    res.json({
      message: outcome === "repaired" ? "Marked as repaired" : "Marked as unrepairable",
      repair_outcome: outcome,
      next_actions: lifecycle.nextActions({ ...shipment, repair_outcome: outcome }),
    });
  } catch (err) {
    handleError(res, err, "Repair result error:");
  }
};

exports.SHIPMENT_STATUSES = SHIPMENT_STATUSES;
