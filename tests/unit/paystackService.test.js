// Exercises the REAL Paystack client (not the manual mock) against a
// stubbed global fetch — covers timeouts and error classification.
const {
  verifyTransaction,
  verifyPayment,
  PaystackUnavailableError,
} = jest.requireActual("../../services/paystackService");

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("paystackService", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("sends the secret key and a timeout signal", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { status: true, data: { status: "success", amount: 100, currency: "NGN" } }),
    );
    await verifyTransaction("ref/with slash");
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("ref%2Fwith%20slash");
    expect(options.headers.Authorization).toBe("Bearer test-paystack-key");
    expect(options.signal).toBeDefined();
  });

  it("classifies a timeout as Paystack being unavailable", async () => {
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );
    await expect(verifyTransaction("r")).rejects.toBeInstanceOf(PaystackUnavailableError);
  });

  it("classifies a 5xx as unavailable", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(502, { status: false, message: "Bad gateway" }));
    await expect(verifyTransaction("r")).rejects.toBeInstanceOf(PaystackUnavailableError);
  });

  it("treats an unknown reference (404) as not paid, not an outage", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(404, { status: false, message: "Transaction reference not found" }),
    );
    const err = await verifyTransaction("r").catch((e) => e);
    expect(err).not.toBeInstanceOf(PaystackUnavailableError);
    expect(err.message).toMatch(/not found/);
  });

  it("treats unreadable JSON as unavailable", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } });
    await expect(verifyTransaction("r")).rejects.toBeInstanceOf(PaystackUnavailableError);
  });

  it("verifyPayment rejects a wrong amount or currency", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { status: true, data: { status: "success", amount: 100, currency: "NGN" } }),
    );
    await expect(verifyPayment("r", 200)).rejects.toThrow(/amount mismatch/);

    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { status: true, data: { status: "success", amount: 100, currency: "USD" } }),
    );
    await expect(verifyPayment("r", 100)).rejects.toThrow(/currency/);
  });
});
