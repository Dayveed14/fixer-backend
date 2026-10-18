const express = require("express");
const router = express.Router();

const diagnosisController = require("../controllers/Diagnosis.Controller");
const { optionalAuth } = require("../middleware/auth");
const { diagnosisLimiter } = require("../middleware/rateLimit");

// Run Smart Issue Analyzer — open to guests, but identity (if any) comes
// from a verified session, and every caller is rate limited.
router.post("/run", optionalAuth, diagnosisLimiter, diagnosisController.runDiagnosis);

module.exports = router;
