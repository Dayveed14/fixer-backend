const request = require("supertest");
const { app, db } = require("../helpers/testApp");
const analyzeIssue = require("../../services/gemini");

beforeEach(() => {
  db.__reset();
  analyzeIssue.mockClear();
});

const baseBody = {
  deviceType: "phone",
  primaryFault: "won't turn on",
};

describe("POST /api/diagnosis/run (public)", () => {
  it("400s without deviceType/primaryFault", async () => {
    const res = await request(app).post("/api/diagnosis/run").send({});
    expect(res.status).toBe(400);
  });

  it("works with no auth token at all", async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 1 }]) // insert diagnosis_requests
      .mockResolvedValueOnce([[]]); // known_issues: none found

    const res = await request(app).post("/api/diagnosis/run").send(baseBody);

    expect(res.status).toBe(200);
  });

  it("returns a knowledge-base match when confidence clears the threshold", async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([
        [
          {
            device_type: "phone",
            primary_fault: "won't turn on",
            keywords: "power,dead,black screen",
            possible_cause: "Battery failure",
            repair_steps: "Replace battery",
          },
        ],
      ]);

    const res = await request(app).post("/api/diagnosis/run").send(baseBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.source).toBe("knowledge_base");
    expect(analyzeIssue).not.toHaveBeenCalled();
  });

  it("falls back to the AI service when nothing in the knowledge base matches well", async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[]]); // no known issues for this device_type at all

    const res = await request(app).post("/api/diagnosis/run").send({
      deviceType: "phone",
      primaryFault: "smells like burnt toast and makes a whistling noise",
    });

    expect(res.status).toBe(200);
    expect(analyzeIssue).toHaveBeenCalledTimes(1);
    // The controller tags this itself — Gemini's own response (see the
    // mock) has no source/success field of its own to rely on.
    expect(res.body.success).toBe(true);
    expect(res.body.source).toBe("ai");
    expect(res.body.likelyProblem).toBe("Mock AI diagnosis");
  });

  it("regression: a query about one thing doesn't false-positive match an unrelated row just because of shared filler words like 'not'/'working'", async () => {
    // The exact bug: "mouse not working" scored 50 points against a
    // totally unrelated "USB-C display output not working" row, purely
    // from "not" and "working" both appearing in each — "mouse" itself
    // matched nothing. This must now correctly fall through to AI.
    db.query
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([
        [
          {
            device_type: "Laptop",
            primary_fault: "USB-C display output not working",
            keywords: "USB-C video, Type-C display",
            possible_cause: "port capability, cable, graphics driver",
          },
          {
            device_type: "Laptop",
            primary_fault: "network is not detected",
            keywords: "network, internet, connectivity, not detected, missing, not found",
            possible_cause: "DNS, DHCP, routing",
          },
        ],
      ]);

    const res = await request(app).post("/api/diagnosis/run").send({
      deviceType: "Laptop",
      primaryFault: "mouse not working",
      description: "mouse doesnt work",
    });

    expect(res.status).toBe(200);
    // Neither unrelated row should have been accepted as a match —
    // must fall through to AI, not claim a false knowledge-base hit.
    expect(res.body.source).toBe("ai");
    expect(analyzeIssue).toHaveBeenCalledTimes(1);
  });
});
