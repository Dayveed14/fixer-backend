const crypto = require("crypto");
const db = require("../config/db"); // mysql2 connection
const analyzeIssue = require("../services/gemini");
const {
  tryConsumeAiBudget,
  withTimeout,
  normalizeAiDiagnosis,
} = require("../services/aiGuard");

const LIMITS = {
  deviceType: 50,
  brand: 100,
  primaryFault: 200,
  description: 2000,
  symptomCount: 20,
  symptomLength: 100,
};

// Validates FixBot input. Returns { ok, message, value }.
function validateDiagnosisInput(body) {
  const {
    deviceType,
    brand = "",
    primaryFault,
    selectedSymptoms = [],
    description = "",
  } = body || {};

  const isText = (v) => typeof v === "string";

  if (!isText(deviceType) || !deviceType.trim() || !isText(primaryFault) || !primaryFault.trim()) {
    return { ok: false, message: "Device type and primary fault are required." };
  }

  if (!isText(brand) || !isText(description)) {
    return { ok: false, message: "brand and description must be text." };
  }

  if (
    !Array.isArray(selectedSymptoms) ||
    selectedSymptoms.some((s) => !isText(s))
  ) {
    return { ok: false, message: "selectedSymptoms must be a list of text values." };
  }

  const tooLong = [
    ["deviceType", deviceType],
    ["brand", brand],
    ["primaryFault", primaryFault],
    ["description", description],
  ].find(([field, value]) => value.length > LIMITS[field]);

  if (tooLong) {
    return {
      ok: false,
      message: `${tooLong[0]} must be at most ${LIMITS[tooLong[0]]} characters.`,
    };
  }

  if (selectedSymptoms.length > LIMITS.symptomCount) {
    return { ok: false, message: `Select at most ${LIMITS.symptomCount} symptoms.` };
  }

  if (selectedSymptoms.some((s) => s.length > LIMITS.symptomLength)) {
    return {
      ok: false,
      message: `Each symptom must be at most ${LIMITS.symptomLength} characters.`,
    };
  }

  return {
    ok: true,
    value: {
      deviceType: deviceType.trim(),
      brand: brand.trim(),
      primaryFault: primaryFault.trim(),
      selectedSymptoms: selectedSymptoms.map((s) => s.trim()).filter(Boolean),
      description: description.trim(),
    },
  };
}

// Records how a diagnosis was answered, for investigating failures.
// Deliberately stores no free text from the customer beyond what the
// request row already holds, and never stores IPs or provider payloads.
// Best-effort: a missing column (migration not yet run) must not break
// FixBot for the customer.
async function recordOutcome(requestId, outcome) {
  try {
    await db.query(
      `UPDATE diagnosis_requests
          SET result_source = ?, failure_reason = ?, latency_ms = ?
        WHERE id = ?`,
      [outcome.source, outcome.failureReason || null, outcome.latencyMs, requestId],
    );
  } catch (err) {
    console.warn("diagnosis outcome not recorded:", err.code || err.message);
  }
}

function logDiagnosis(event) {
  // One structured line per request — no description/brand text.
  console.info(JSON.stringify({ type: "fixbot", ...event }));
}

exports.validateDiagnosisInput = validateDiagnosisInput;

exports.runDiagnosis = async (req, res) => {
  const startedAt = Date.now();
  const traceId = crypto.randomBytes(6).toString("hex");

  try {
    const validation = validateDiagnosisInput(req.body);

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        message: validation.message,
      });
    }

    const {
      deviceType,
      brand,
      primaryFault,
      selectedSymptoms,
      description,
    } = validation.value;

    // Identity comes ONLY from a verified token (optionalAuth). Any
    // user_id in the request body is ignored, so a guest can't file
    // diagnoses under someone else's account.
    const user_id = req.user?.id || null;
    const callerKey = user_id ? `user:${user_id}` : `ip:${req.ip}`;

    //--------------------------------------------------
    // Save request
    //--------------------------------------------------

    const [request] = await db.query(
      `INSERT INTO diagnosis_requests
            (
                user_id,
                device_type,
                brand_model,
                primary_fault,
                symptoms,
                description
            )

            VALUES (?, ?, ?, ?, ?, ?)`,

      [
        user_id,
        deviceType,
        brand || null,
        primaryFault,
        JSON.stringify(selectedSymptoms),
        description || null,
      ],
    );

    //--------------------------------------------------
    // Search knowledge base
    //--------------------------------------------------

    const [issues] = await db.query(
      `
        SELECT *
        FROM known_issues
        WHERE device_type = ?
        `,
      [deviceType],
    );
    //--------------------------------------------------
    // Matching Engine
    //--------------------------------------------------

    const synonyms = {
      wont: "not",
      cant: "cannot",
      doesnt: "not",
      dont: "not",
      bootloop: "boot loop",
      wifi: "wireless",
      restart: "reboot",
      restarting: "reboot",
      frozen: "freeze",
      hangs: "freeze",
      hanging: "freeze",
      dead: "not turning on",
      blackscreen: "black screen",
    };

    const stopWords = [
      "the",
      "a",
      "an",
      "my",
      "is",
      "are",
      "of",
      "to",
      "and",
      "please",
      "help",
      "device",
      "computer",
      "laptop",
      "phone",
      // These appear in almost every row once negation synonyms are
      // normalized ("won't"/"can't"/"doesn't"/"don't" all become "not"),
      // so on their own they don't discriminate between issues at all —
      // without excluding them, "X not working" can score high against
      // literally any "not working" row regardless of what X is.
      "not",
      "no",
      "cannot",
      "working",
      "work",
      "issue",
      "issues",
      "problem",
      "problems",
      "wrong",
    ];

    function normalize(text = "") {
      text = text
        .toString()
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      Object.entries(synonyms).forEach(([key, value]) => {
        text = text.replace(new RegExp(`\\b${key}\\b`, "g"), value);
      });

      return text;
    }

    function tokenize(text = "") {
      return normalize(text)
        .split(" ")
        .filter(Boolean)
        .filter((word) => !stopWords.includes(word));
    }

    function scoreIssue(issue, form) {
      let score = 0;
      // Tracks whether any point actually came from a meaningful,
      // discriminating word — as opposed to only from generic filler
      // that happens to appear in most rows. Filler-only matches must
      // never be enough to call something a match on their own.
      let hadRealMatch = false;

      //-----------------------------------
      // Exact / Partial Primary Fault
      //-----------------------------------

      const normalizedFault = normalize(form.primaryFault);
      const normalizedIssueFault = normalize(issue.primary_fault);

      if (
        normalizedIssueFault.includes(normalizedFault) ||
        normalizedFault.includes(normalizedIssueFault)
      ) {
        score += 50;
        hadRealMatch = true;
      }

      //-----------------------------------
      // Word Matching
      //-----------------------------------

      const faultWords = tokenize(form.primaryFault);
      const issueWords = tokenize(issue.primary_fault);

      faultWords.forEach((word) => {
        issueWords.forEach((dbWord) => {
          if (dbWord.includes(word) || word.includes(dbWord)) {
            score += 20;
            hadRealMatch = true;
          }
        });
      });

      //-----------------------------------
      // Symptoms
      //-----------------------------------

      const dbKeywords = (issue.keywords || "")
        .split(",")
        .map((keyword) => normalize(keyword))
        .filter(Boolean);

      (form.selectedSymptoms || []).forEach((symptom) => {
        const s = normalize(symptom);

        dbKeywords.forEach((keyword) => {
          if (s.includes(keyword) || keyword.includes(s)) {
            score += 10;
            hadRealMatch = true;
          }
        });
      });

      //-----------------------------------
      // Description
      //-----------------------------------

      const searchableText = normalize(`
    ${issue.primary_fault}
    ${issue.keywords}
    ${issue.possible_cause || ""}
    ${issue.repair_steps || ""}
  `);

      const descriptionWords = tokenize(form.description || "");

      descriptionWords.forEach((word) => {
        if (searchableText.includes(word)) {
          score += 5;
          hadRealMatch = true;
        }
      });

      //-----------------------------------
      // Brand
      //-----------------------------------

      if (form.brand) {
        const searchableBrand = normalize(`
      ${issue.primary_fault}
      ${issue.keywords}
      ${issue.possible_cause || ""}
    `);

        const normalizedBrand = normalize(form.brand);

        if (searchableBrand.includes(normalizedBrand)) {
          score += 10;
          hadRealMatch = true;
        }
      }

      //-----------------------------------
      // Confidence Bonus
      //-----------------------------------

      if (score >= 70) {
        score += 10;
      }

      // Safety net: even with the expanded stopword list, this is a
      // second line of defense so a future filler word we haven't
      // thought of can't silently start producing false "matches"
      // again — a row can only ever count as relevant if something
      // meaningful actually matched.
      return hadRealMatch ? score : 0;
    }

    const ranked = issues
      .map((issue) => ({
        ...issue,
        score: scoreIssue(issue, {
          primaryFault,
          selectedSymptoms,
          description,
          brand,
        }),
      }))
      .sort((a, b) => b.score - a.score);

    const CONFIDENCE_THRESHOLD = 30;
    const MAX_RESULTS = 5;

    const matches = ranked.slice(0, MAX_RESULTS);

    matches.forEach((issue) => {
      issue.confidence = Math.max(1, Math.min(issue.score, 100));
    });

    const bestScore = matches.length ? matches[0].score : 0;

    //--------------------------------------------------
    // Respond based on whether the top match cleared the threshold
    //--------------------------------------------------

    const requestId = request.insertId;

    if (bestScore >= CONFIDENCE_THRESHOLD) {
      const latencyMs = Date.now() - startedAt;
      await recordOutcome(requestId, { source: "knowledge_base", latencyMs });
      logDiagnosis({ traceId, requestId, source: "knowledge_base", latencyMs, guest: !user_id });

      return res.json({
        success: true,

        source: "knowledge_base",

        requestId,

        results: matches,
      });
    }

    //--------------------------------------------------
    // No confident match — AI fallback, within budget
    //--------------------------------------------------

    // Partial matches we can still show if the AI isn't available.
    const suggestions = matches.filter((m) => m.score > 0).slice(0, 3);

    const noMatch = async (reason, message) => {
      const latencyMs = Date.now() - startedAt;
      await recordOutcome(requestId, {
        source: "no_match",
        failureReason: reason,
        latencyMs,
      });
      logDiagnosis({ traceId, requestId, source: "no_match", reason, latencyMs, guest: !user_id });

      return res.json({
        success: true,
        source: "no_match",
        requestId,
        reason,
        message,
        suggestions,
      });
    };

    const budget = tryConsumeAiBudget(callerKey);

    if (!budget.allowed) {
      return noMatch(
        budget.reason === "caller_limit" ? "ai_daily_limit" : "ai_capacity",
        "We couldn't find a confident match in our repair knowledge base. A technician can take a look — book a call or send your device in.",
      );
    }

    let aiResult;
    try {
      const raw = await withTimeout(
        analyzeIssue({
          deviceType,
          brand,
          primaryFault,
          selectedSymptoms,
          description,
        }),
      );
      aiResult = normalizeAiDiagnosis(raw);
    } catch (aiError) {
      const reason =
        aiError.name === "AiTimeoutError"
          ? "ai_timeout"
          : aiError.name === "AiInvalidResponseError" || aiError instanceof SyntaxError
            ? "ai_invalid_response"
            : "ai_unavailable";

      console.error(`FixBot AI fallback failed [${traceId}]:`, aiError.message);

      return noMatch(
        reason,
        "Our AI assistant is unavailable right now, and we couldn't find a confident match in our knowledge base. A technician can help — book a call or send your device in.",
      );
    }

    const latencyMs = Date.now() - startedAt;
    await recordOutcome(requestId, { source: "ai", latencyMs });
    logDiagnosis({ traceId, requestId, source: "ai", latencyMs, guest: !user_id });

    // Tag this explicitly rather than leaving the frontend to infer
    // "not knowledge_base" == AI from the shape of the response.
    return res.json({
      success: true,
      source: "ai",
      requestId,
      ...aiResult,
    });
  } catch (err) {
    // Never leak internal error text (SQL, stack details) to the client.
    console.error(`FixBot error [${traceId}]:`, err);

    res.status(500).json({
      success: false,
      message: "Something went wrong while running the diagnosis. Please try again.",
    });
  }
};
