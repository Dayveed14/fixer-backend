const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// --------------------------------------------------
// Generate content with retry
// --------------------------------------------------

async function generateWithRetry(payload, retries = 3, delay = 1000) {
  try {
    return await ai.models.generateContent(payload);
  } catch (err) {
    const isTemporaryError =
      err.status === 503 ||
      err.code === 503 ||
      /unavailable|high demand|overloaded/i.test(err.message || "");

    if (retries > 0 && isTemporaryError) {
      console.warn(
        `Gemini temporarily unavailable. Retrying in ${delay}ms... (${retries} attempts left)`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      return generateWithRetry(payload, retries - 1, delay * 2);
    }

    throw err;
  }
}

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

  const prompt = `
You are Fixer's AI technical diagnosis assistant.

You are an experienced computer hardware and software technician.

Analyze the customer's device problem using the information provided below.

DEVICE TYPE:
${deviceType}

BRAND / MODEL:
${brand || "Not provided"}

PRIMARY FAULT:
${primaryFault}

SELECTED SYMPTOMS:
${selectedSymptoms.join(", ") || "None provided"}

CUSTOMER DESCRIPTION:
${description || "No additional description provided"}

Your task is to:

1. Identify the most likely problem.
2. Estimate your confidence from 0 to 100.
3. Determine the severity.
4. List the most likely causes.
5. Provide safe troubleshooting steps the customer can try.
6. Determine whether the customer should book a technician.
7. Determine whether mail-in repair may be appropriate.

Important:

- Do not claim certainty when the symptoms are ambiguous.
- Do not recommend dangerous electrical or hardware procedures to an ordinary customer.
- If the problem could involve electrical damage, liquid damage, burning smell, smoke, swollen battery, or other safety risks, recommend professional service.
- Keep troubleshooting steps practical and easy to understand.
- Do not invent information that was not provided.

Return ONLY valid JSON using this exact structure:

{
  "likelyProblem": "",
  "confidence": 0,
  "severity": "",
  "causes": [],
  "steps": [],
  "estimatedRepair": "",
  "bookTechnician": false,
  "mailInRepair": false
}
`;

  try {
    // --------------------------------------------------
    // Primary model
    // --------------------------------------------------

    const response = await generateWithRetry({
      model: "gemini-3.8-flash",
      contents: prompt,

      config: {
        responseMimeType: "application/json",
      },
    });

    return JSON.parse(response.text.trim());
  } catch (err) {
    console.warn("Primary Gemini model failed. Trying fallback model...");

    // --------------------------------------------------
    // Fallback model
    // --------------------------------------------------

    try {
      const fallbackResponse = await generateWithRetry(
        {
          model: "gemini-3.7-flash",
          contents: prompt,

          config: {
            responseMimeType: "application/json",
          },
        },
        2,
        1000,
      );

      return JSON.parse(fallbackResponse.text.trim());
    } catch (fallbackError) {
      console.error("Gemini Error:", fallbackError);

      throw fallbackError;
    }
  }
}

module.exports = analyzeIssue;
