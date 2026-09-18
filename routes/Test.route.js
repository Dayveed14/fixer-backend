const express = require("express");
const { generateInviteLink } = require("../services/meshCentralService");
const { verifyToken, authorize } = require("../middleware/auth");

const router = express.Router();

router.get("/mesh/test", verifyToken, authorize("admin"), async (req, res) => {
  try {
    const link = await generateInviteLink();

    res.json({
      success: true,
      invite: link,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
module.exports = router;

