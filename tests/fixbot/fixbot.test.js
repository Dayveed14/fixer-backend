// Priority 4 — FixBot: knowledge base first, AI fallback within budget,
// graceful degradation, identity from verified sessions only.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const analyzeIssue = require("../../services/gemini");
const { resetAiBudget } = require("../../services/aiGuard");

const KNOWN = {
  id: 7,
  device_type: "Laptop",
  primary_fault: "Overheating",
  keywords: "overheating, hot, fan noise",
  possible_cause: "Dust in the fan",
  repair_steps: "Clean the vents",
};

function givenKnowledgeBase(rows) {
  routeQueries(db.query, [
    [/INSERT INTO diagnosis_requests/, [{ insertId: 101 }]],
    [/FROM known_issues/, [rows]],
  ]);
}

const run = (body, auth) => {
  const req = request(app).post("/api/diagnosis/run");
  if (auth) req.set("Authorization", auth);
  return req.send(body);
};

const unknownIssue = { deviceType: "Laptop", primaryFault: "hinge squeaks like a mouse" };

const savedEnv = { ...process.env };

beforeEach(() => {
  db.__reset();
  resetAiBudget();
  analyzeIssue.mockReset().mockResolvedValue({
    likelyProblem: "Worn hinge",
    confidence: 65,
    severity: "Low",
    causes: ["Wear"],
    steps: ["Tighten the hinge screws"],
    estimatedRepair: "₦8,000",
    bookTechnician: false,
    mailInRepair: true,
  });
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("knowledge-base match", () => {
  it("answers from the knowledge base without calling the AI", async () => {
    givenKnowledgeBase([KNOWN]);
    const res = await run({ deviceType: "Laptop", primaryFault: "Overheating", selectedSymptoms: ["Overheating"] });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("knowledge_base");
    expect(res.body.requestId).toBe(101);
    expect(res.body.results[0].id).toBe(7);
    expect(analyzeIssue).not.toHaveBeenCalled();

    const [outcome] = callsMatching(db.query, /UPDATE diagnosis_requests/);
    expect(outcome[1][0]).toBe("knowledge_base");
  });
});

describe("no suitable knowledge-base match", () => {
  it("falls back to the AI and returns a normalised result", async () => {
    givenKnowledgeBase([KNOWN]);
    const res = await run(unknownIssue);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: "ai",
      requestId: 101,
      likelyProblem: "Worn hinge",
      severity: "low", // normalised
      mailInRepair: true,
    });
    expect(analyzeIssue).toHaveBeenCalledTimes(1);
  });
});

describe("AI provider failure", () => {
  it("degrades to a no_match answer instead of a 500", async () => {
    givenKnowledgeBase([]);
    analyzeIssue.mockRejectedValueOnce(Object.assign(new Error("503 overloaded"), { status: 503 }));

    const res = await run(unknownIssue);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, source: "no_match", reason: "ai_unavailable" });
    expect(res.body.message).toMatch(/technician/);
    const [outcome] = callsMatching(db.query, /UPDATE diagnosis_requests/);
    expect(outcome[1].slice(0, 2)).toEqual(["no_match", "ai_unavailable"]);
  });

  it("times out a hanging provider", async () => {
    process.env.AI_TIMEOUT_MS = "30";
    givenKnowledgeBase([]);
    analyzeIssue.mockReturnValueOnce(new Promise(() => {}));

    const res = await run(unknownIssue);

    expect(res.body).toMatchObject({ source: "no_match", reason: "ai_timeout" });
  });
});

describe("malformed AI response", () => {
  it.each([
    ["missing fields", { confidence: 50 }],
    ["not an object", "Sure! Here is your diagnosis..."],
    ["an array", [{ likelyProblem: "x" }]],
  ])("rejects %s", async (_label, raw) => {
    givenKnowledgeBase([]);
    analyzeIssue.mockResolvedValueOnce(raw);
    const res = await run(unknownIssue);
    expect(res.body).toMatchObject({ source: "no_match", reason: "ai_invalid_response" });
  });

  it("treats unparseable JSON from the provider as invalid", async () => {
    givenKnowledgeBase([]);
    analyzeIssue.mockRejectedValueOnce(new SyntaxError("Unexpected token"));
    const res = await run(unknownIssue);
    expect(res.body.reason).toBe("ai_invalid_response");
  });
});

describe("AI cost controls", () => {
  it("stops calling the AI once a caller's daily allowance is used, but still answers", async () => {
    process.env.AI_DAILY_LIMIT_PER_CALLER = "1";
    givenKnowledgeBase([]);

    const first = await run(unknownIssue);
    const second = await run(unknownIssue);

    expect(first.body.source).toBe("ai");
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ source: "no_match", reason: "ai_daily_limit" });
    expect(analyzeIssue).toHaveBeenCalledTimes(1);
  });

  it("knowledge-base answers don't consume AI budget", async () => {
    process.env.AI_DAILY_LIMIT_PER_CALLER = "1";
    givenKnowledgeBase([KNOWN]);
    await run({ deviceType: "Laptop", primaryFault: "Overheating" });
    await run({ deviceType: "Laptop", primaryFault: "Overheating" });

    givenKnowledgeBase([]);
    const res = await run(unknownIssue);
    expect(res.body.source).toBe("ai");
  });

  it("applies a global daily cap across all callers", async () => {
    process.env.AI_DAILY_LIMIT_GLOBAL = "1";
    givenKnowledgeBase([]);
    await run(unknownIssue, authHeader({ id: 1, role: "user" }));
    const res = await run(unknownIssue, authHeader({ id: 2, role: "user" }));
    expect(res.body.reason).toBe("ai_capacity");
  });
});

describe("identity comes from the verified session only", () => {
  it("ignores user_id in the body for a guest", async () => {
    givenKnowledgeBase([KNOWN]);
    await run({ ...unknownIssue, user_id: 42 });
    const [insert] = callsMatching(db.query, /INSERT INTO diagnosis_requests/);
    expect(insert[1][0]).toBeNull();
  });

  it("uses the token's id for a signed-in customer, not the body's", async () => {
    givenKnowledgeBase([KNOWN]);
    await run({ ...unknownIssue, user_id: 42 }, authHeader({ id: 3, role: "user" }));
    const [insert] = callsMatching(db.query, /INSERT INTO diagnosis_requests/);
    expect(insert[1][0]).toBe(3);
  });

  it("treats an invalid token as a guest rather than rejecting or trusting it", async () => {
    givenKnowledgeBase([KNOWN]);
    const res = await run({ ...unknownIssue, user_id: 42 }, "Bearer garbage.token.here");
    expect(res.status).toBe(200);
    const [insert] = callsMatching(db.query, /INSERT INTO diagnosis_requests/);
    expect(insert[1][0]).toBeNull();
  });
});

describe("request size and shape", () => {
  it.each([
    ["description over 2000 chars", { description: "x".repeat(2001) }],
    ["primaryFault over 200 chars", { primaryFault: "x".repeat(201) }],
    ["too many symptoms", { selectedSymptoms: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
    ["symptoms not an array", { selectedSymptoms: "Overheating" }],
    ["non-string symptom", { selectedSymptoms: [{ $gt: "" }] }],
    ["object as deviceType", { deviceType: { toString: 1 } }],
  ])("400s %s without saving anything", async (_label, override) => {
    const res = await run({ ...unknownIssue, ...override });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
    expect(analyzeIssue).not.toHaveBeenCalled();
  });

  it("413s a body over the JSON size limit", async () => {
    const res = await run({ ...unknownIssue, description: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("diagnostic records", () => {
  it("doesn't leak internal error details to the client", async () => {
    db.query.mockRejectedValueOnce(new Error("ER_ACCESS_DENIED_ERROR for user 'root'@'10.0.0.5'"));
    const res = await run(unknownIssue);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/root|ER_ACCESS/);
  });

  it("still answers if the outcome columns haven't been migrated yet", async () => {
    routeQueries(db.query, [
      [/INSERT INTO diagnosis_requests/, [{ insertId: 101 }]],
      [/FROM known_issues/, [[KNOWN]]],
      [/UPDATE diagnosis_requests/, () => {
        throw Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" });
      }],
    ]);
    const res = await run({ deviceType: "Laptop", primaryFault: "Overheating" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("knowledge_base");
  });

  it("logs a structured line without the customer's description", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    givenKnowledgeBase([KNOWN]);
    await run({ deviceType: "Laptop", primaryFault: "Overheating", description: "my secret password is hunter2" });
    const line = info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("fixbot"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/hunter2/);
    info.mockRestore();
  });
});
