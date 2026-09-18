const jwt = require("jsonwebtoken");

/* ===========================
   VERIFY TOKEN
   Requires a valid "Authorization: Bearer <token>" header.
   On success, attaches the decoded payload ({ id, email, role, iat, exp })
   to req.user for downstream handlers and authorize() to use.
=========================== */
function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      message: "Authentication required. Please log in.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Session expired. Please log in again.",
      });
    }

    return res.status(401).json({
      message: "Invalid authentication token.",
    });
  }
}

/* ===========================
   AUTHORIZE
   Role gate. Use after verifyToken. Call as authorize("admin"),
   authorize("admin", "technician"), etc.
=========================== */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required. Please log in.",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "You do not have permission to perform this action.",
      });
    }

    return next();
  };
}

module.exports = { verifyToken, authorize };
