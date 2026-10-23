const sendMail = require("../services/mailService");
const escapeHtml = require("../utils/escapeHtml");
const { isEmail, textProblem } = require("../utils/validate");

exports.sendContactMessage = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({
        message: "name, email and message are required.",
      });
    }

    const problem = textProblem(req.body, {
      name: [120, true],
      subject: [200, false],
      message: [5000, true],
    });
    if (problem) {
      return res.status(400).json({ message: problem });
    }

    if (!isEmail(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    // Everything the visitor typed is escaped: the email is HTML, and
    // the subject line can't carry new lines (header injection).
    const cleanSubject = String(subject || `New message from ${name}`).replace(/[\r\n]+/g, " ");

    await sendMail(
      {
        to: process.env.CONTACT_EMAIL_TO,
        replyTo: email.trim(),
        subject: `[Contact Form] ${cleanSubject}`,
        html: `
      <p><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
      <p><strong>Subject:</strong> ${escapeHtml(subject || "N/A")}</p>
      <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
    `,
      },
      "support", // ← mailbox key, not an email address
    );
    res.status(200).json({
      message: "Message sent.",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message:
        "Unable to send your message right now. Please try again shortly.",
    });
  }
};
