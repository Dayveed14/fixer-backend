const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { callsMatching } = require("../helpers/sqlRouter");
const { tomorrow, yesterday, daysFromNow } = require("../helpers/dates");

beforeEach(() => db.__reset());

const customer = () => authHeader({ id: 3, email: "ada@example.com", role: "user" });

describe("POST /api/payments/initialize", () => {
  it("401s with no session", async () => {
    const res = await request(app).post("/api/payments/initialize").send({});
    expect(res.status).toBe(401);
  });

  it.each(["technician", "admin"])("403s for a %s (only customers pay)", async (role) => {
    const res = await request(app)
      .post("/api/payments/initialize")
      .set("Authorization", authHeader({ role }))
      .send({ purpose: "booking" });
    expect(res.status).toBe(403);
  });

  it("400s an unknown purpose", async () => {
    const res = await request(app)
      .post("/api/payments/initialize")
      .set("Authorization", customer())
      .send({ purpose: "donation" });
    expect(res.status).toBe(400);
  });

  describe("booking", () => {
    it("prices the call on the server and stores a pending payment for the caller", async () => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({
          purpose: "booking",
          support_type: "video",
          booking_date: tomorrow(),
          booking_time: "10:00",
          amount: 1, // ignored — client never sets the price
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        amount: 7000,
        amount_kobo: 700000,
        currency: "NGN",
        email: "ada@example.com",
      });
      expect(res.body.reference).toMatch(/^FXB_/);

      const [insert] = callsMatching(db.query, /INSERT INTO payment_transactions/);
      const [reference, userId, email, purpose, amountKobo, metadata] = insert[1];
      expect(reference).toBe(res.body.reference);
      expect(userId).toBe(3);
      expect(email).toBe("ada@example.com");
      expect(purpose).toBe("booking");
      expect(amountKobo).toBe(700000);
      expect(JSON.parse(metadata)).toEqual({
        support_type: "video",
        booking_date: tomorrow(),
        booking_time: "10:00:00",
      });

      // Audited.
      expect(callsMatching(db.query, /INSERT INTO payment_events/)).toHaveLength(1);
    });

    it("400s an invalid support type", async () => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({ purpose: "booking", support_type: "premium", booking_date: tomorrow(), booking_time: "10:00" });
      expect(res.status).toBe(400);
    });

    it.each([
      ["a past date", () => yesterday(), "10:00"],
      ["before 8 AM", () => tomorrow(), "07:00"],
      ["10 PM or later", () => tomorrow(), "22:00"],
      ["over 30 days ahead", () => daysFromNow(45), "10:00"],
    ])("400s %s and creates no payment", async (_label, date, time) => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({ purpose: "booking", support_type: "voice", booking_date: date(), booking_time: time });
      expect(res.status).toBe(400);
      expect(callsMatching(db.query, /INSERT INTO payment_transactions/)).toHaveLength(0);
    });
  });

  describe("shipment", () => {
    it.each([
      ["garki", 2000],
      ["lugbe", 4000],
      ["kubwa", 4500],
    ])("charges the %s zone fee (₦%i)", async (zone, fee) => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({ purpose: "shipment", zone, pickup_date: tomorrow(), pickup_time: "11:00" });

      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(fee);
      expect(res.body.reference).toMatch(/^FXS_/);
    });

    it("400s an unknown zone", async () => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({ purpose: "shipment", zone: "ikeja", pickup_date: tomorrow(), pickup_time: "11:00" });
      expect(res.status).toBe(400);
    });

    it("400s a pickup at 21:30 (pickups must finish by 10 PM)", async () => {
      const res = await request(app)
        .post("/api/payments/initialize")
        .set("Authorization", customer())
        .send({ purpose: "shipment", zone: "garki", pickup_date: tomorrow(), pickup_time: "21:30" });
      expect(res.status).toBe(400);
    });
  });

  it("500s cleanly if the payment row can't be saved", async () => {
    db.query.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .post("/api/payments/initialize")
      .set("Authorization", customer())
      .send({ purpose: "booking", support_type: "voice", booking_date: tomorrow(), booking_time: "10:00" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal Server Error");
  });
});

describe("public pricing/slot endpoints", () => {
  it("GET /api/shipments/zones lists Abuja zones with fees", async () => {
    const res = await request(app).get("/api/shipments/zones");
    expect(res.status).toBe(200);
    expect(res.body.office).toMatch(/Wuse/);
    expect(res.body.zones.find((z) => z.id === "kubwa").fee).toBe(4500);
  });

  it("GET /api/bookings/support-types lists call prices", async () => {
    const res = await request(app).get("/api/bookings/support-types");
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.id)).toEqual(["voice", "video", "remote"]);
  });

  it("GET /api/bookings/slots returns all slots for tomorrow", async () => {
    const res = await request(app).get(`/api/bookings/slots?date=${tomorrow()}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toEqual(res.body.all);
    expect(res.body.all[0]).toBe("08:00");
  });

  it("GET /api/shipments/slots 400s a bad date", async () => {
    const res = await request(app).get("/api/shipments/slots?date=tomorrow");
    expect(res.status).toBe(400);
  });
});
