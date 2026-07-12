const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
async function analyzeIssue(data) {
  try {
    const {
      deviceType,
      brand,
      primaryFault,
      selectedSymptoms,
      description,
    } = data;

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
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
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
