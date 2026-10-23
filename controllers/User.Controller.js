const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { COOKIE_NAME, cookieOptions } = require("../config/cookie");
const { isEmail, isText, passwordProblem, textProblem } = require("../utils/validate");
const { invalidateSession } = require("../services/sessionService");
const sendMail = require("../services/mailService");
const escapeHtml = require("../utils/escapeHtml");

// Used to spend the same bcrypt time when the email doesn't exist, so
// response timing doesn't reveal which emails have accounts.
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.TFbqo/6Yvb5mhW0ZcZlUj3V4Cj6e";

function issueSession(res, user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, tv: Number(user.token_version) || 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1d", algorithm: "HS256" },
  );
  res.cookie(COOKIE_NAME, token, cookieOptions);
}

// Shared by self-registration and admin-created accounts.
function accountProblem({ first_name, last_name, email, phone, password }) {
  if (!first_name || !last_name || !email || !password) return "Please fill all required fields.";
  if ([first_name, last_name, email].some((v) => !isText(v)) || (phone != null && !isText(phone))) {
    return "Invalid registration details.";
  }
  const lengths = textProblem({ first_name, last_name, phone }, { first_name: [80, true], last_name: [80, true], phone: [30, false] });
  if (lengths) return "One or more fields are too long.";
  if (!isEmail(email)) return "Please enter a valid email address.";
  return passwordProblem(password);
}

/* ===========================
   REGISTER USER
=========================== */

exports.registerUser = async (req, res) => {
  try {
    let { first_name, last_name, email, phone, password } = req.body || {};

    const problem = accountProblem({ first_name, last_name, email, phone, password });
    if (problem) {
      return res.status(400).json({ message: problem });
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

    // Insert user (role is never taken from the request — new accounts
    // are always customers; staff accounts come from POST /users/create)
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
    let { first_name, last_name, email, phone, password, role } = req.body || {};

    if (!role) {
      return res.status(400).json({ message: "Please fill all required fields." });
    }

    const problem = accountProblem({ first_name, last_name, email, phone, password });
    if (problem) {
      return res.status(400).json({ message: problem });
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
      phone || null,
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
    // Admins get contact details; everyone else only needs names.
    const columns =
      req.user?.role === "admin"
        ? "id, first_name, last_name, email, phone, role, created_at"
        : "id, first_name, last_name";
    const [technicians] = await db.query(
      `SELECT ${columns} FROM users WHERE role = 'technician' ORDER BY first_name ASC`,
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
    let { email, password } = req.body || {};

    if (!isText(email) || !isText(password) || !email.trim() || !password) {
      return res.status(400).json({
        message: "Email and password are required.",
      });
    }

    email = email.trim().toLowerCase();

    const [result] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    const user = result[0];

    // Same message and (roughly) the same time whether the email is
    // unknown or the password is wrong — no account enumeration.
    const validPassword = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

    if (!user || !validPassword) {
      return res.status(401).json({
        message: "Incorrect email or password.",
      });
    }

    // The session is an httpOnly cookie; the token is never in the body.
    issueSession(res, user);

    return res.json({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   LOGOUT USER
   Clears the auth cookie. The frontend can't clear an httpOnly cookie
   itself, so it has to ask the server to do it.
=========================== */
exports.logoutUser = async (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });

  return res.json({ message: "Logged out." });
};

/* ===========================
   GET CURRENT USER
   Lets the frontend restore "who am I" on page load/refresh purely from
   the cookie, without needing to have kept anything in localStorage.
=========================== */
exports.getMe = async (req, res) => {
  try {
    const [result] = await db.query(
      "SELECT id, first_name, last_name, email, phone, role FROM users WHERE id = ?",
      [req.user.id],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json(result[0]);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   CHANGE PASSWORD (any logged-in role)
   PATCH /api/users/me/password  { current_password, new_password }
   Ends every other session (token_version + 1) and gives this browser
   a fresh session, then emails the account owner a security notice.
=========================== */
exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};

    if (!isText(current_password) || !current_password) {
      return res.status(400).json({ message: "Enter your current password." });
    }

    const problem = passwordProblem(new_password);
    if (problem) {
      return res.status(400).json({ message: problem });
    }

    if (new_password === current_password) {
      return res.status(400).json({ message: "Choose a password you haven't just used." });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const user = rows[0];

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (!(await bcrypt.compare(current_password, user.password))) {
      return res.status(400).json({ message: "Your current password is incorrect." });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    const nextVersion = (Number(user.token_version) || 0) + 1;

    try {
      await db.query(
        "UPDATE users SET password = ?, token_version = ?, password_changed_at = NOW() WHERE id = ?",
        [hashed, nextVersion, user.id],
      );
    } catch (err) {
      // Before the migration adds the session columns.
      if (err.code !== "ER_BAD_FIELD_ERROR") throw err;
      await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, user.id]);
    }

    invalidateSession(user.id);
    issueSession(res, { ...user, token_version: nextVersion });

    try {
      await sendMail(
        {
          to: user.email,
          subject: "Your Fixer password was changed",
          html: `
            <p>Hi ${escapeHtml(user.first_name)},</p>
            <p>The password for your Fixer account was just changed, and you've been signed out on other devices.</p>
            <p>If this wasn't you, reply to this email straight away so we can secure your account.</p>
            <p>Fixer Support</p>`,
        },
        "support",
      );
    } catch (mailError) {
      console.error("Password-change email failed:", mailError.message);
    }

    return res.json({ message: "Password changed. You've been signed out on other devices." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

/* ===========================
   ADMIN: VIEW / EDIT / DELETE A USER
   Admin accounts can't be edited or deleted from here (stops an admin
   locking out another admin, or themselves). A role change ends that
   person's sessions automatically (the session check compares roles).
=========================== */
const MANAGEABLE_ROLES = ["user", "technician"];

async function loadManageable(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: "Invalid user id." });
    return null;
  }
  const [rows] = await db.query(
    "SELECT id, first_name, last_name, email, phone, role, created_at FROM users WHERE id = ?",
    [id],
  );
  const target = rows[0];
  if (!target) {
    res.status(404).json({ message: "User not found." });
    return null;
  }
  if (!MANAGEABLE_ROLES.includes(target.role)) {
    res.status(403).json({ message: "Admin accounts can't be changed here." });
    return null;
  }
  return target;
}

exports.getUserById = async (req, res) => {
  try {
    const target = await loadManageable(req, res);
    if (!target) return undefined;
    return res.json(target);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const target = await loadManageable(req, res);
    if (!target) return undefined;

    const { first_name, last_name, phone, role } = req.body || {};
    const problem = textProblem(
      { first_name, last_name, phone },
      { first_name: [80, true], last_name: [80, true], phone: [30, false] },
    );
    if (problem) return res.status(400).json({ message: problem });

    const nextRole = role === undefined ? target.role : role;
    if (!MANAGEABLE_ROLES.includes(nextRole)) {
      return res.status(400).json({ message: "Invalid role selected." });
    }

    await db.query(
      "UPDATE users SET first_name = ?, last_name = ?, phone = ?, role = ? WHERE id = ?",
      [first_name.trim(), last_name.trim(), phone ? String(phone).trim() : null, nextRole, target.id],
    );

    if (nextRole !== target.role) invalidateSession(target.id);

    return res.json({ message: "User updated." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const target = await loadManageable(req, res);
    if (!target) return undefined;

    // Keep the money trail intact: anyone with payments, bookings or
    // repairs can't be deleted.
    const [[history]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM payment_transactions WHERE user_id = ?) +
         (SELECT COUNT(*) FROM bookings WHERE user_id = ? OR technician_id = ?) +
         (SELECT COUNT(*) FROM shipments WHERE user_id = ? OR technician_id = ?) AS n`,
      [target.id, target.id, target.id, target.id, target.id],
    );
    if (Number(history.n) > 0) {
      return res.status(409).json({
        message: "This account has bookings, repairs or payments on record, so it can't be deleted.",
      });
    }

    await db.query("DELETE FROM users WHERE id = ?", [target.id]);
    invalidateSession(target.id);
    return res.json({ message: "User deleted." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
