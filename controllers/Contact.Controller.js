const sendMail = require("../services/mailService");

exports.sendContactMessage = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({
        message: "name, email and message are required.",
      });
    }

    await sendMail(
      {
        to: process.env.CONTACT_EMAIL_TO,
        replyTo: email,
        subject: `[Contact Form] ${subject || `New message from ${name}`}`,
        html: `
      <p><strong>From:</strong> ${name} (${email})</p>
      <p><strong>Subject:</strong> ${subject || "N/A"}</p>
      <p style="white-space: pre-wrap;">${message}</p>
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
