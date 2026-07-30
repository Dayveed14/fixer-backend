const nodemailer = require("nodemailer");


const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  family: 4, // Force IPv4
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
