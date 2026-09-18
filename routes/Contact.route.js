const express = require("express");

const router = express.Router();

const contact = require("../controllers/Contact.Controller");
const { contactLimiter } = require("../middleware/rateLimit");

router.post("/", contactLimiter, contact.sendContactMessage);

module.exports = router;
