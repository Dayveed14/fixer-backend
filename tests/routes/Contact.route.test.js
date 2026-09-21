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
