// Default: Paystack says the payment succeeded for ₦5,000. Payment
// tests override verifyTransaction per-call to return whatever amount
// the payment row under test expects (or a failed/abandoned status).
class PaystackUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaystackUnavailableError";
  }
}

const verifyTransaction = jest.fn().mockResolvedValue({
  status: "success",
  currency: "NGN",
  amount: 500000,
  id: 123456,
  channel: "card",
});

const verifyPayment = jest.fn().mockResolvedValue({
  status: "success",
  currency: "NGN",
  amount: 500000,
});

module.exports = { verifyTransaction, verifyPayment, PaystackUnavailableError };
