const express = require("express");
const router = express.Router();

const diagnosisController = require("../controllers/Diagnosis.Controller");

// Run Smart Issue Analyzer
router.post("/run", diagnosisController.runDiagnosis);

module.exports = router;
