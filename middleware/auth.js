const jwt = require("jsonwebtoken");
const { COOKIE_NAME, cookieOptions } = require("../config/cookie");
const { getSessionState } = require("../services/sessionService");

function readToken(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return { token: cookieToken, fromCookie: true };

  const [scheme, headerToken] = (req.headers.authorization || "").split(" ");
  if (scheme === "Bearer" && headerToken) return { token: headerToken, fromCookie: false };

  return { token: null, fromCookie: false };
}

function reject(res, fromCookie, message) {
  // A dead cookie is cleared so the browser stops sending it.
  if (fromCookie) res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
  return res.status(401).json({ message });
}

/* ===========================
   VERIFY TOKEN
   Reads the token from the httpOnly cookie (web app) or an
   "Authorization: Bearer <token>" header (other clients, tests).
   Checks the signature and expiry, then that the session is still
   current: the account exists, its role hasn't changed, and the
   password hasn't been changed since the token was issued.
   On success, req.user = { id, email, role, tv, iat, exp }.
=========================== */
async function verifyToken(req, res, next) {
  const { token, fromCookie } = readToken(req);

  if (!token) {
    return res.status(401).json({ message: "Authentication required. Please log in." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    return reject(
      res,
      fromCookie,
      err.name === "TokenExpiredError"
        ? "Session expired. Please log in again."
        : "Invalid authentication token.",
    );
  }

  try {
    const state = await getSessionState(decoded.id);

    if (state === null) {
      return reject(res, fromCookie, "This account no longer exists.");
    }

    if (state.role !== undefined && state.role !== decoded.role) {
      return reject(res, fromCookie, "Your access has changed. Please log in again.");
    }

    if (state.version !== undefined && (Number(decoded.tv) || 0) !== state.version) {
      return reject(res, fromCookie, "Session ended. Please log in again.");
    }
  } catch (err) {
    console.error("Session check failed:", err.message);
    return res.status(503).json({ message: "Service temporarily unavailable. Please try again." });
  }

  req.user = decoded;
  return next();
}

/* ===========================
   AUTHORIZE
   Role gate. Use after verifyToken: authorize("admin"),
   authorize("admin", "technician"), etc.
=========================== */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required. Please log in." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have permission to perform this action." });
    }

    return next();
  };
}

/* ===========================
   OPTIONAL AUTH
   For endpoints open to guests that should still know a logged-in
   caller (FixBot). Identity only ever comes from a valid token; an
   invalid one is treated as a guest.
=========================== */
function optionalAuth(req, res, next) {
  const { token } = readToken(req);

  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      req.user = undefined;
    }
  }

  return next();
}

module.exports = { verifyToken, authorize, optionalAuth };
