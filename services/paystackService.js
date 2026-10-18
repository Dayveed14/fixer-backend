const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_TIMEOUT_MS = Number(process.env.PAYSTACK_TIMEOUT_MS) || 10000;

// Thrown when Paystack itself can't be reached or answers with an
// error — as opposed to Paystack answering "this payment failed". The
// payment service treats this as "still pending, try again" rather than
// marking the transaction failed.
class PaystackUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaystackUnavailableError";
  }
}

// Verifies a transaction reference directly with Paystack's servers.
// Never trust a "payment succeeded" claim from the frontend alone — the
// frontend popup can be tampered with, so every booking/shipment must be
// confirmed here before being written to the DB.
async function verifyTransaction(reference) {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    throw new PaystackUnavailableError("PAYSTACK_SECRET_KEY is not set.");
  }

  if (!reference) {
    throw new Error("Missing payment reference.");
  }

  let response;
  try {
    response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        // Without a timeout a hung Paystack call would hold the request
        // (and, worse, a DB connection) open indefinitely.
        signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const reason =
      err.name === "TimeoutError" || err.name === "AbortError"
        ? "timed out"
        : "could not be reached";
    throw new PaystackUnavailableError(`Paystack ${reason}. Please try again.`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new PaystackUnavailableError("Paystack returned an unreadable response.");
  }

  if (!response.ok || !body.status) {
    // 404/400 here means Paystack has no such transaction — e.g. the
    // popup was closed before paying. That's a real "not paid", not an
    // outage, so it's a plain Error.
    if (response.status >= 500) {
      throw new PaystackUnavailableError(
        body.message || "Paystack is temporarily unavailable.",
      );
    }
    throw new Error(body.message || "Unable to verify payment with Paystack.");
  }

  // body.data.status is "success" | "abandoned" | "failed" | "ongoing" | ...
  return body.data;
}

// Confirms a transaction actually paid the exact amount (in kobo) we expect,
// in NGN, and succeeded.
async function verifyPayment(reference, expectedAmountKobo) {
  const data = await verifyTransaction(reference);

  if (data.status !== "success") {
    throw new Error(`Payment was not successful (status: ${data.status}).`);
  }

  if (data.currency !== "NGN") {
    throw new Error(`Unexpected payment currency: ${data.currency}.`);
  }

  if (data.amount !== expectedAmountKobo) {
    throw new Error(
      `Payment amount mismatch. Expected ${expectedAmountKobo} kobo, got ${data.amount}.`,
    );
  }

  return data;
}

module.exports = { verifyTransaction, verifyPayment, PaystackUnavailableError };
