const nodemailer = require("nodemailer");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first"); // Node 18+, do this before creating transporters

const SMTP_HOST = process.env.SMTP_HOST || "mail.privateemail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = SMTP_PORT === 465;

function createTransporter(user, pass) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true for 465, false for 587 (STARTTLS)
    requireTLS: !SMTP_SECURE,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    family: 4,
    auth: { user, pass },
  });
}

// Three Namecheap Private Email mailboxes, each used for a different kind of
// outgoing mail so replies land in the right inbox:
//   - support:        customer-facing (booking confirmations, session links)
//   - admin:           internal alerts (new booking notifications)
//   - notifications:   technician-facing (job assignments)
const mailboxes = {
  support: {
    user: process.env.SUPPORT_EMAIL_USER,
    pass: process.env.SUPPORT_EMAIL_PASS,
    fromName: "Fixer Support",
  },
  admin: {
    user: process.env.ADMIN_EMAIL_USER,
    pass: process.env.ADMIN_EMAIL_PASS,
    fromName: "Fixer Alerts",
  },
  notifications: {
    user: process.env.NOTIFY_EMAIL_USER,
    pass: process.env.NOTIFY_EMAIL_PASS,
    fromName: "Fixer Notifications",
  },
};

const transporters = {};

function getTransporter(mailbox) {
  const config = mailboxes[mailbox];

  if (!config || !config.user || !config.pass) {
    throw new Error(
      `Mailbox "${mailbox}" is not configured — check the matching *_EMAIL_USER / *_EMAIL_PASS vars in .env`,
    );
  }

  if (!transporters[mailbox]) {
    transporters[mailbox] = createTransporter(config.user, config.pass);
  }

  return transporters[mailbox];
}

// sendMail(options, mailbox?) — mailbox defaults to "support".
// options is the usual nodemailer message object (to, subject, html, ...).
const sendMail = async (options, mailbox = "support") => {
  try {
    const config = mailboxes[mailbox];
    const transporter = getTransporter(mailbox);

    await transporter.sendMail({
      from: `"${config.fromName}" <${config.user}>`,
      ...options,
    });

    console.log(`Email sent via ${mailbox} mailbox (${config.user})`);
  } catch (err) {
    console.error(`Failed to send email via ${mailbox} mailbox:`, err.message);
  }
};

module.exports = sendMail;
