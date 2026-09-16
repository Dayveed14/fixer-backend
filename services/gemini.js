const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Helper function to handle retries with exponential backoff
async function generateWithRetry(payload, retries = 3, delay = 1000) {
  try {
    return await ai.models.generateContent(payload);
  } catch (err) {
    // Check if error is a 503 (Unavailable) or overloaded status
    if (
      retries > 0 &&
      (err.status === 503 ||
        err.code === 503 ||
        /unavailable|high demand/i.test(err.message))
    ) {
      console.warn(
        `Gemini is experiencing high demand (503). Retrying in ${delay}ms... (${retries} attempts left)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return generateWithRetry(payload, retries - 1, delay * 2); // Double the delay each time
    }
    throw err;
  }
}

async function analyzeIssue(data) {
  try {
    const { deviceType, brand, primaryFault, selectedSymptoms, description } =
      data;

    const prompt = `
You are an experienced computer hardware and software technician.

Analyze the customer's computer issue.

Device Type:
${deviceType}

Brand:
${brand}

Primary Fault:
${primaryFault}

Selected Symptoms:
${selectedSymptoms}

Description:
${description}

Return ONLY valid JSON in this exact format:

{
  "likelyProblem":"",
  "confidence":0,
  "severity":"",
  "causes":[],
  "steps":[],
  "estimatedRepair":"",
  "bookTechnician":false,
  "mailInRepair":false
}
`;

    // Use the retry wrapper instead of direct call
    const response = await generateWithRetry({
      model: "gemini-3.6-flash",
      contents: prompt,
    });

    const text = response.text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(text);
  } catch (err) {
    console.error("Gemini Error:", err);
    throw err;
  }
}

module.exports = analyzeIssue;
