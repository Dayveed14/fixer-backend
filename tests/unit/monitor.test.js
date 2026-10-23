jest.mock("../../config/db");
jest.mock("../../services/mailService");

const express = require("express");
const request = require("supertest");
const db = require("../../config/db");
const sendMail = require("../../services/mailService");
const monitor = require("../../services/monitor");

const realFetch = global.fetch;

beforeEach(() => {
  db.__reset();
  sendMail.mockClear();
  monitor.resetMonitor();
  process.env.ADMIN_EMAIL = "ops@example.com";
  delete process.env.ALERT_WEBHOOK_URL;
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe("alert()", () => {
  it("logs a JSON line, emails the admin and posts to the webhook", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/abc";

    expect(await monitor.alert("k1", "Something broke", { reference: "FXB_1" })).toBe(true);

    expect(console.error.mock.calls.some(([line]) => /"event":"fixer_alert"/.test(line))).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@example.com", subject: "[Fixer alert] Something broke" }),
      "admin",
    );
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://hooks.example/abc");
    expect(JSON.parse(init.body).text).toMatch(/CRITICAL: Something broke[\s\S]*reference: FXB_1/);
  });

  it("throttles repeats of the same alert", async () => {
    await monitor.alert("same", "Once");
    expect(await monitor.alert("same", "Once")).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("escapes HTML in the email", async () => {
    await monitor.alert("x", "<img src=x>", { note: "<script>" });
    const { html } = sendMail.mock.calls[0][0];
    expect(html).not.toMatch(/<img|<script>/);
  });

  it("never throws even if email and webhook fail", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/abc";
    global.fetch.mockRejectedValue(new Error("down"));
    sendMail.mockRejectedValueOnce(new Error("resend down"));
    await expect(monitor.alert("y", "Still fine")).resolves.toBe(true);
  });
});

describe("requestMonitor", () => {
  const app = express();
  app.use(monitor.requestMonitor);
  app.get("/ok", (req, res) => res.send("ok"));
  app.get("/boom", (req, res) => res.status(500).send("no"));

  it("alerts once the 5xx threshold is crossed within 5 minutes", async () => {
    process.env.ALERT_5XX_THRESHOLD = "3";
    await request(app).get("/ok");
    await request(app).get("/boom");
    await request(app).get("/boom");
    expect(sendMail).not.toHaveBeenCalled();
    await request(app).get("/boom");
    await new Promise((r) => setImmediate(r));

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/3 server errors/) }), "admin");
    const snap = monitor.snapshot();
    expect(snap.requests).toBe(4);
    expect(snap.server_errors).toBe(3);
    expect(snap.errors_by_route["GET /boom"]).toBe(3);
    delete process.env.ALERT_5XX_THRESHOLD;
  });
});

describe("checkPaymentHealth()", () => {
  it("alerts on paid payments that never created anything", async () => {
    db.query
      .mockResolvedValueOnce([[{ reference: "FXB_9", purpose: "booking", amount_kobo: 1500000, user_id: 3 }]])
      .mockResolvedValueOnce([[{ count: 0 }]]);

    const findings = await monitor.checkPaymentHealth();

    expect(findings).toEqual({ unfulfilled: 1, failed_last_hour: 0 });
    expect(db.query.mock.calls[0][0]).toMatch(/status = 'success' AND entity_id IS NULL/);
    expect(sendMail.mock.calls[0][0].html).toMatch(/FXB_9 \(booking, ₦15000\)/);
  });

  it("alerts on a spike of failed payments", async () => {
    db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ count: 7 }]]);
    await monitor.checkPaymentHealth();
    expect(sendMail.mock.calls[0][0].subject).toMatch(/7 failed\/mismatched payments/);
  });

  it("stays quiet when everything is fine", async () => {
    db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ count: 0 }]]);
    await monitor.checkPaymentHealth();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
