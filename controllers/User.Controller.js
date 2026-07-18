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
    const [result] = await db.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);

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

    await db.query(sql, [first_name, last_name, email, phone, hashedPassword]);

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
   CREATE USER
=========================== */

exports.createUser = async (req, res) => {
  try {
    let { first_name, last_name, email, phone, password, role } = req.body;

    // Validate required fields
    if (!first_name || !last_name || !email || !password || !role) {
      return res.status(400).json({
        message: "Please fill all required fields.",
      });
    }

    // Clean input
    first_name = first_name.trim();
    last_name = last_name.trim();
    email = email.trim().toLowerCase();

    // Check if email already exists
    const [result] = await db.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);

    if (result.length > 0) {
      return res.status(400).json({
        message: "Email already exists.",
      });
    }

    const allowedRoles = ["user", "technician"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        message: "Invalid role selected.",
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
        password,
        role
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await db.query(sql, [
      first_name,
      last_name,
      email,
      phone,
      hashedPassword,
      role,
    ]);

    return res.status(201).json({
      message: "User created successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET TECHNICIANS
   Powers the admin's technician-assignment dropdown.
=========================== */

exports.getTechnicians = async (req, res) => {
  try {
    const [technicians] = await db.query(
      "SELECT id, first_name, last_name, email, phone, role, created_at FROM users WHERE role = 'technician' ORDER BY first_name ASC",
    );

    return res.json(technicians);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

// GET ALL USERS

exports.getUsers = async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, first_name, last_name, email, phone, role, created_at FROM users ORDER BY role DESC",
    );

    return res.json(users);
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
    const [result] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (result.length === 0) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    const user = result[0];

    // Compare password
    const validPassword = await bcrypt.compare(password, user.password);

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
      },
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
