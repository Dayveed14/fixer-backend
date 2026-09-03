const db = require("../config/db"); // mysql2 connection
const analyzeIssue = require("../services/gemini");
exports.runDiagnosis = async (req, res) => {
  try {
    const {
      user_id,
      deviceType,
      brand,
      primaryFault,
      selectedSymptoms,
      description,
    } = req.body;

    if (!deviceType || !primaryFault) {
      return res.status(400).json({
        success: false,
        message: "Device type and primary fault are required.",
      });
    }

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
        user_id || null,
        deviceType,
        brand,
        primaryFault,
        JSON.stringify(selectedSymptoms),
        description,
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
        }
      }

      //-----------------------------------
      // Confidence Bonus
      //-----------------------------------

      if (score >= 70) {
        score += 10;
      }

      return score;
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

    if (bestScore >= CONFIDENCE_THRESHOLD) {
      return res.json({
        success: true,

        source: "knowledge_base",

        requestId: request.insertId,

        results: matches,
      });
    }

    //--------------------------------------------------
    // No match yet
    //--------------------------------------------------

    // Otherwise use Gemini
    const aiResult = await analyzeIssue({
      deviceType,
      brand,
      primaryFault,
      selectedSymptoms,
      description,
    });

    return res.json(aiResult);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,

      message: err.message,
    });
  }
};
