// Appointments: session type rules, meeting links, completion without an amount.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const { generateInviteLink } = require("../../services/meshCentralService");
const { createVideoMeeting, jitsiMeeting, googleConfigured } = jest.requireActual("../../services/meetingService");

const TECH = authHeader({ id: 5, role: "technician" });

beforeEach(() => {
  db.__reset();
  generateInviteLink.mockClear();
});

describe("start session depends on the call type", () => {
  const booking = (support_type) => ({
    id: 20,
    status: "confirmed",
    booking_reference: "#BK1020",
    support_type,
    technician_id: 5,
    customer_email: "ada@example.com",
  });

  it.each([
    ["voice", /call the customer/],
    ["video", /meeting link/],
  ])("refuses MeshCentral for a %s call", async (type, message) => {
    db.query.mockResolvedValueOnce([[booking(type)]]);
    const res = await request(app).post("/api/bookings/20/remote-session").set("Authorization", TECH);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(generateInviteLink).not.toHaveBeenCalled();
  });

  it("creates a MeshCentral invite for remote support", async () => {
    db.query.mockResolvedValueOnce([[booking("remote_desktop")]]);
    const res = await request(app).post("/api/bookings/20/remote-session").set("Authorization", TECH);
    expect(res.status).toBe(200);
    expect(generateInviteLink).toHaveBeenCalled();
  });
});

describe("meeting links for video calls", () => {
  it("falls back to a Jitsi room when Google isn't configured", async () => {
    expect(googleConfigured({})).toBe(false);
    const meeting = await createVideoMeeting({ bookingReference: "#BK1020" }, {});
    expect(meeting.provider).toBe("jitsi");
    expect(meeting.url).toMatch(/^https:\/\/meet\.jit\.si\/Fixer-BK1020-[0-9a-f]{10}$/);
  });

  it("uses Google Meet when configured, and falls back if Google fails", async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@x.iam.gserviceaccount.com",
      GOOGLE_PRIVATE_KEY: require("crypto").generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
      GOOGLE_CALENDAR_ID: "support@fixerng.app",
      GOOGLE_IMPERSONATE_USER: "support@fixerng.app",
    };
    const realFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ hangoutLink: "https://meet.google.com/abc-defg-hij" }) });

    const meeting = await createVideoMeeting({ bookingReference: "#BK1", startsAt: "2026-11-03T10:00:00+01:00", customerEmail: "ada@example.com" }, env);
    expect(meeting).toEqual({ url: "https://meet.google.com/abc-defg-hij", provider: "google_meet" });
    const eventBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(eventBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(eventBody.attendees).toEqual([{ email: "ada@example.com" }]);

    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    expect((await createVideoMeeting({ bookingReference: "#BK2" }, env)).provider).toBe("jitsi");
    err.mockRestore();
    global.fetch = realFetch;
  });

  it("jitsi rooms are unguessable", () => {
    expect(jitsiMeeting("#BK1").url).not.toBe(jitsiMeeting("#BK1").url);
  });

  it("staff can (re)create a link for a video booking only", async () => {
    db.query.mockResolvedValueOnce([[{ id: 20, booking_reference: "#BK1020", support_type: "voice", technician_id: 5 }]]);
    expect((await request(app).post("/api/bookings/20/meeting").set("Authorization", TECH)).status).toBe(400);

    db.query.mockResolvedValueOnce([[{ id: 20, booking_reference: "#BK1020", support_type: "video", technician_id: 5, booking_date: "2026-11-03", booking_time: "10:00:00" }]]);
    const res = await request(app).post("/api/bookings/20/meeting").set("Authorization", TECH);
    expect(res.status).toBe(200);
    expect(res.body.meeting_url).toMatch(/meet\.jit\.si/);
    expect(callsMatching(db.query, /SET meeting_url = \?/)).toHaveLength(1);
  });

  it("another technician can't", async () => {
    db.query.mockResolvedValueOnce([[{ id: 20, support_type: "video", technician_id: 9 }]]);
    expect((await request(app).post("/api/bookings/20/meeting").set("Authorization", TECH)).status).toBe(403);
  });
});

describe("completing jobs needs no amount", () => {
  it("completing a booking also completes its linked ticket", async () => {
    routeQueries(db.query, [[/SELECT technician_id FROM bookings/, [[{ technician_id: 5 }]]]]);
    const res = await request(app)
      .patch("/api/bookings/20/status")
      .set("Authorization", TECH)
      .send({ status: "completed" });
    expect(res.status).toBe(200);
    const [ticket] = callsMatching(db.query, /UPDATE tickets SET status = 'Completed'/);
    expect(ticket[1]).toEqual(["20"]);
  });

  it("a ticket can be completed without an amount, keeping any existing amount", async () => {
    db.query.mockResolvedValueOnce([[{ technician_id: 5 }]]);
    const res = await request(app)
      .patch("/api/tickets/30/status")
      .set("Authorization", TECH)
      .send({ status: "Completed" });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/amount = COALESCE\(\?, amount\)/);
    expect(params).toEqual(["Completed", null, "30"]);
  });

  it("rejects a negative amount", async () => {
    db.query.mockResolvedValueOnce([[{ technician_id: 5 }]]);
    const res = await request(app)
      .patch("/api/tickets/30/status")
      .set("Authorization", TECH)
      .send({ status: "Completed", amount: -5 });
    expect(res.status).toBe(400);
  });
});
