const request = require("supertest");
const { app } = require("../helpers/testApp");
const sendMail = require("../../services/mailService");

beforeEach(() => {
  sendMail.mockClear();
});

describe("POST /api/contact (public)", () => {
  it("400s a missing field", async () => {
    const res = await request(app).post("/api/contact").send({ name: "Ada" });
    expect(res.status).toBe(400);
  });

  it("200s and sends the message, no auth required", async () => {
    const res = await request(app).post("/api/contact").send({
      name: "Ada",
      email: "ada@example.com",
      message: "Hello, I need help.",
    });

    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("500s gracefully if the mail service throws", async () => {
    sendMail.mockRejectedValueOnce(new Error("Resend is down"));

    const res = await request(app).post("/api/contact").send({
      name: "Ada",
      email: "ada@example.com",
      message: "Hello, I need help.",
    });

    expect(res.status).toBe(500);
  });
});

describe("contact form hardening", () => {
  it("escapes HTML and strips new lines from the subject", async () => {
    const res = await request(app).post("/api/contact").send({
      name: "<b>Eve</b>",
      email: "eve@example.com",
      subject: "Hi\r\nBcc: everyone@example.com",
      message: "<script>alert(1)</script>",
    });

    expect(res.status).toBe(200);
    const [mail] = sendMail.mock.calls[0];
    expect(mail.html).not.toMatch(/<script>|<b>Eve/);
    expect(mail.html).toMatch(/&lt;script&gt;/);
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("rejects an invalid reply-to email", async () => {
    const res = await request(app).post("/api/contact").send({ name: "Eve", email: "nope", message: "Hi" });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects a huge message", async () => {
    const res = await request(app)
      .post("/api/contact")
      .send({ name: "Eve", email: "eve@example.com", message: "x".repeat(5001) });
    expect(res.status).toBe(400);
  });
});
