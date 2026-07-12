const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

/* ===========================
   REGISTER USER
=========================== */

exports.registerUser = async (req, res) => {
  try {
    let { first_name, last_name, email, phone, password } = req.body;

    // Validate required fields
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({
        message: "Please fill all required fields.",
      });
    }

    // Clean input
    first_name = first_name.trim();
    last_name = last_name.trim();
    email = email.trim().toLowerCase();

    // Check if email already exists
    const [result] = await db.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (result.length > 0) {
      return res.status(400).json({
        message: "Email already exists.",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const sql = `
      INSERT INTO users
      (
        first_name,
        last_name,
        email,
        phone,
        password
      )
      VALUES (?, ?, ?, ?, ?)
    `;

    await db.query(sql, [
      first_name,
      last_name,
      email,
      phone,
      hashedPassword,
    ]);

    return res.status(201).json({
      message: "Registration Successful",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   LOGIN USER
=========================== */

exports.loginUser = async (req, res) => {
  try {
    let { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required.",
      });
    }

    email = email.trim().toLowerCase();

    // Find user
    const [result] = await db.query(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (result.length === 0) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    const user = result[0];

    // Compare password
    const validPassword = await bcrypt.compare(
      password,
      user.password
    );

    if (!validPassword) {
      return res.status(401).json({
        message: "Incorrect password.",
      });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1d",
      }
    );

    return res.json({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      token,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};