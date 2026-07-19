const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendMail = async (options) => {
  try {
    await transporter.sendMail({
      from: `"Fixer Support" <${process.env.EMAIL_USER}>`,
      ...options,
    });

    console.log("Email sent");
  } catch (err) {
    console.error(err);
  }
};

module.exports = sendMail;
