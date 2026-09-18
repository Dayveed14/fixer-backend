const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// --------------------------------------------------
// Retry helper
// --------------------------------------------------

async function generateWithRetry(payload, retries = 3, delay = 1000) {
  try {
    return await groq.chat.completions.create(payload);
  } catch (err) {
    const status = err.status || err.statusCode;

    const isTemporaryError =
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      /rate limit|too many requests|overloaded|timeout|temporarily unavailable/i.test(
        err.message || "",
      );

    if (retries > 0 && isTemporaryError) {
      console.warn(
        `Groq temporarily unavailable. Retrying in ${delay}ms... (${retries} attempts left)`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      return generateWithRetry(payload, retries - 1, delay * 2);
    }

    throw err;
  }
}

// --------------------------------------------------
// Diagnosis JSON Schema
// --------------------------------------------------

const diagnosisSchema = {
  type: "object",

  properties: {
    likelyProblem: {
      type: "string",
    },

    confidence: {
      type: "number",
    },

    severity: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },

    causes: {
      type: "array",
      items: {
        type: "string",
      },
    },

    steps: {
      type: "array",
      items: {
        type: "string",
      },
    },

    estimatedRepair: {
      type: "string",
    },

    bookTechnician: {
      type: "boolean",
    },

    mailInRepair: {
      type: "boolean",
    },
  },

  required: [
    "likelyProblem",
    "confidence",
    "severity",
    "causes",
    "steps",
    "estimatedRepair",
    "bookTechnician",
    "mailInRepair",
  ],

  additionalProperties: false,
};

// --------------------------------------------------
// AI Diagnosis
// --------------------------------------------------

async function analyzeIssue(data) {
  const {
    deviceType,
    brand,
    primaryFault,
    selectedSymptoms = [],
    description = "",
  } = data;

  const systemPrompt = `
You are Fixer's AI technical diagnosis assistant.

You are an experienced computer hardware and software technician.

Your job is to analyze customer-reported device problems and provide a
practical preliminary diagnosis.

You must reason carefully from the symptoms provided.

IMPORTANT RULES:

1. Do not claim certainty when the symptoms are ambiguous.
2. Do not invent information that the customer did not provide.
3. The confidence value must be between 0 and 100.
4. "severity" must be one of:
   - low
   - medium
   - high
   - critical
5. Provide practical troubleshooting steps.
6. Do not recommend dangerous electrical repairs to ordinary customers.
7. If the device has smoke, burning smell, liquid damage, a swollen battery,
   electrical damage, or another safety concern, recommend professional help.
8. If the problem requires opening the device or specialized equipment,
   recommend booking a technician.
9. "mailInRepair" should only be true when the issue is reasonably suitable
   for physical repair/shipping.
10. "bookTechnician" should be true when professional assistance is advisable.

The output must follow the supplied JSON schema exactly.
`;

  const userPrompt = `
DEVICE TYPE:
${deviceType}

BRAND / MODEL:
${brand || "Not provided"}

PRIMARY FAULT:
${primaryFault}

SELECTED SYMPTOMS:
${selectedSymptoms.length ? selectedSymptoms.join(", ") : "None provided"}

CUSTOMER DESCRIPTION:
${description || "No additional description provided"}

Analyze this issue and provide the preliminary Fixer diagnosis.
`;

  try {
    const response = await generateWithRetry({
      model: "openai/gpt-oss-120b",

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],

      response_format: {
        type: "json_schema",

        json_schema: {
          name: "fixer_diagnosis",

          strict: true,

          schema: diagnosisSchema,
        },
      },

      temperature: 0.2,
    });

    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Groq returned an empty response.");
    }

    return JSON.parse(content);
  } catch (err) {
    console.error("Groq Diagnosis Error:", err);

    throw err;
  }
}

module.exports = analyzeIssue;
