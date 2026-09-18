const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

// Verifies a transaction reference directly with Paystack's servers.
// Never trust a "payment succeeded" claim from the frontend alone — the
// frontend popup can be tampered with, so every booking/shipment must be
// confirmed here before being written to the DB.
async function verifyTransaction(reference) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error("PAYSTACK_SECRET_KEY is not set in .env");
  }

  if (!reference) {
    throw new Error("Missing payment reference.");
  }

  const response = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      },
    },
  );

  const body = await response.json();

  if (!response.ok || !body.status) {
    throw new Error(body.message || "Unable to verify payment with Paystack.");
  }

  // body.data.status is "success" | "abandoned" | "failed" | ...
  return body.data;
}

// Confirms a transaction actually paid the exact amount (in kobo) we expect,
// in NGN, and succeeded — call this instead of verifyTransaction directly
// wherever a specific charge amount needs to be enforced.
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

module.exports = { verifyTransaction, verifyPayment };
