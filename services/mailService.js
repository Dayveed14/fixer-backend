const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// Three Fixer sender identities.
// All three use the same verified fixerng.app domain.
const mailboxes = {
  support: {
    user: "support@fixerng.app",
    fromName: "Fixer Support",
  },

  admin: {
    user: "admin@fixerng.app",
    fromName: "Fixer Alerts",
  },

  notifications: {
    user: "notifications@fixerng.app",
    fromName: "Fixer Notifications",
  },
};

const sendMail = async (options, mailbox = "support") => {
  try {
    const config = mailboxes[mailbox];

    if (!config) {
      throw new Error(`Unknown mailbox: ${mailbox}`);
    }

    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const { data, error } = await resend.emails.send({
      from: `"${config.fromName}" <${config.user}>`,
      ...options,
    });

    if (error) {
      throw new Error(error.message || "Resend failed to send email");
    }

    console.log(
      `Email sent via ${mailbox} mailbox (${config.user})`,
      data?.id ? `ID: ${data.id}` : "",
    );

    return data;
  } catch (err) {
    console.error(`Failed to send email via ${mailbox} mailbox:`, err.message);

    throw err;
  }
};

module.exports = sendMail;
