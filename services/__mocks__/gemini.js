// Matches the REAL services/gemini.js return shape — Gemini's raw
// parsed JSON, with no success/source/results wrapper of its own.
// (The controller is responsible for adding success/source/requestId
// around whatever this returns — that's what tests/routes/Diagnosis.route.test.js
// actually verifies, rather than trusting the mock to supply them.)
module.exports = jest.fn().mockResolvedValue({
  likelyProblem: "Mock AI diagnosis",
  confidence: 50,
  severity: "Medium",
  causes: ["Mock cause"],
  steps: ["Mock step"],
  estimatedRepair: "₦5,000",
  bookTechnician: false,
  mailInRepair: false,
});
