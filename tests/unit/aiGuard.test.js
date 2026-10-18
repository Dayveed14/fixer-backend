const {
  tryConsumeAiBudget,
  resetAiBudget,
  withTimeout,
  normalizeAiDiagnosis,
} = require("../../services/aiGuard");

describe("AI budget (cost control)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    resetAiBudget();
    process.env.AI_DAILY_LIMIT_PER_CALLER = "2";
    process.env.AI_DAILY_LIMIT_GLOBAL = "3";
  });
  afterAll(() => {
    process.env = saved;
    resetAiBudget();
  });

  it("caps each caller per day", () => {
    expect(tryConsumeAiBudget("ip:1").allowed).toBe(true);
    expect(tryConsumeAiBudget("ip:1").allowed).toBe(true);
    expect(tryConsumeAiBudget("ip:1")).toEqual({ allowed: false, reason: "caller_limit" });
  });

  it("caps everyone combined per day", () => {
    tryConsumeAiBudget("a");
    tryConsumeAiBudget("b");
    tryConsumeAiBudget("c");
    expect(tryConsumeAiBudget("d")).toEqual({ allowed: false, reason: "global_limit" });
  });

  it("resets the next day", () => {
    const day1 = new Date("2026-11-02T10:00:00Z");
    const day2 = new Date("2026-11-03T10:00:00Z");
    tryConsumeAiBudget("x", day1);
    tryConsumeAiBudget("x", day1);
    expect(tryConsumeAiBudget("x", day1).allowed).toBe(false);
    expect(tryConsumeAiBudget("x", day2).allowed).toBe(true);
  });
});

describe("withTimeout", () => {
  it("rejects with AiTimeoutError when the provider is too slow", async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 20)).rejects.toMatchObject({ name: "AiTimeoutError" });
  });

  it("passes a fast result through", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});

describe("normalizeAiDiagnosis (malformed responses)", () => {
  const good = {
    likelyProblem: "Faulty charging port",
    confidence: 72,
    severity: "High",
    causes: ["Debris", "Worn port"],
    steps: ["Clean the port"],
    estimatedRepair: "₦15,000",
    bookTechnician: true,
    mailInRepair: false,
  };

  it("accepts a well-formed response and lower-cases severity", () => {
    expect(normalizeAiDiagnosis(good)).toMatchObject({ severity: "high", confidence: 72 });
  });

  it.each([null, "text", [], {}, { likelyProblem: "" }, { likelyProblem: 5 }])(
    "rejects %p",
    (raw) => {
      expect(() => normalizeAiDiagnosis(raw)).toThrow(
        expect.objectContaining({ name: "AiInvalidResponseError" }),
      );
    },
  );

  it("clamps confidence, defaults unknown severity, drops non-string list items, coerces booleans", () => {
    const result = normalizeAiDiagnosis({
      ...good,
      confidence: 400,
      severity: "apocalyptic",
      causes: ["ok", 5, null, { x: 1 }],
      steps: "not a list",
      bookTechnician: "yes",
    });
    expect(result.confidence).toBe(100);
    expect(result.severity).toBe("medium");
    expect(result.causes).toEqual(["ok"]);
    expect(result.steps).toEqual([]);
    expect(result.bookTechnician).toBe(false);
  });

  it("caps oversized output", () => {
    const result = normalizeAiDiagnosis({
      ...good,
      likelyProblem: "x".repeat(5000),
      steps: Array.from({ length: 50 }, (_, i) => `step ${i}`),
    });
    expect(result.likelyProblem.length).toBe(200);
    expect(result.steps.length).toBe(10);
  });
});
