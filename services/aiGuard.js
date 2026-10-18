/* ===========================
   AI GUARD — cost, timeout and output controls for FixBot's AI fallback

   - Budget: a per-caller daily cap and a global daily cap on AI calls.
     The knowledge base still answers once the cap is hit; only the paid
     AI fallback stops. Counters are in-memory, which is correct for a
     single Render instance (they reset on restart/deploy — a safe
     direction to fail in). If you scale to several instances, move
     these counters to MySQL or Redis.
   - Timeout: the provider call is abandoned after AI_TIMEOUT_MS so a
     slow model can't hold requests open.
   - Output: the model's JSON is validated and normalised before it ever
     reaches a customer; anything malformed is rejected.
=========================== */

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const limits = () => ({
  perCallerDaily: envInt("AI_DAILY_LIMIT_PER_CALLER", 10),
  globalDaily: envInt("AI_DAILY_LIMIT_GLOBAL", 300),
  timeoutMs: envInt("AI_TIMEOUT_MS", 20000),
});

let day = null;
let globalCount = 0;
const perCaller = new Map();

function rollDay(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    globalCount = 0;
    perCaller.clear();
  }
}

/**
 * Reserves one AI call for `callerKey`. Returns { allowed: true } or
 * { allowed: false, reason: "caller_limit" | "global_limit" }.
 */
function tryConsumeAiBudget(callerKey, now = new Date()) {
  rollDay(now);
  const { perCallerDaily, globalDaily } = limits();

  if (globalCount >= globalDaily) {
    return { allowed: false, reason: "global_limit" };
  }

  const used = perCaller.get(callerKey) || 0;
  if (used >= perCallerDaily) {
    return { allowed: false, reason: "caller_limit" };
  }

  perCaller.set(callerKey, used + 1);
  globalCount += 1;
  return { allowed: true };
}

function resetAiBudget() {
  day = null;
  globalCount = 0;
  perCaller.clear();
}

class AiTimeoutError extends Error {
  constructor(ms) {
    super(`AI provider did not respond within ${ms}ms.`);
    this.name = "AiTimeoutError";
  }
}

class AiInvalidResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiInvalidResponseError";
  }
}

function withTimeout(promise, ms = limits().timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AiTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SEVERITIES = ["low", "medium", "high", "critical"];

const cleanString = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const cleanList = (value, maxItems, maxLength) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength));

/**
 * Validates and normalises the model's diagnosis. Throws
 * AiInvalidResponseError if it isn't usable.
 */
function normalizeAiDiagnosis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AiInvalidResponseError("AI response was not an object.");
  }

  const likelyProblem = cleanString(raw.likelyProblem, 200);
  if (!likelyProblem) {
    throw new AiInvalidResponseError("AI response had no likelyProblem.");
  }

  const confidenceNumber = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.round(Math.max(0, Math.min(100, confidenceNumber)))
    : 0;

  const severityRaw = cleanString(raw.severity, 20).toLowerCase();
  const severity = SEVERITIES.includes(severityRaw) ? severityRaw : "medium";

  return {
    likelyProblem,
    confidence,
    severity,
    causes: cleanList(raw.causes, 8, 300),
    steps: cleanList(raw.steps, 10, 500),
    estimatedRepair: cleanString(String(raw.estimatedRepair ?? ""), 100),
    bookTechnician: raw.bookTechnician === true,
    mailInRepair: raw.mailInRepair === true,
  };
}

module.exports = {
  tryConsumeAiBudget,
  resetAiBudget,
  withTimeout,
  normalizeAiDiagnosis,
  AiTimeoutError,
  AiInvalidResponseError,
};
