const express = require("express");

const router = express.Router();

const payment = require("../controllers/Payment.Controller");
const { paymentFlowLimiter } = require("../middleware/rateLimit");
const { verifyToken, authorize } = require("../middleware/auth");

// Paystack -> us. No session; authenticated by signature inside the handler.
router.post("/webhook", payment.paystackWebhook);

router.post(
  "/initialize",
  verifyToken,
  authorize("user"),
  paymentFlowLimiter,
  payment.initializePayment,
);

router.get("/", verifyToken, authorize("admin"), payment.listPayments);

router.get(
  "/:reference/events",
  verifyToken,
  authorize("admin"),
  payment.getPaymentEvents,
);

router.get("/:reference", verifyToken, payment.getPayment);

module.exports = router;
