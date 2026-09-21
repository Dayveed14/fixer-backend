// Cross-origin cookie rules, in one place so login/logout/the auth
// middleware can't drift out of sync with each other.
//
// The frontend (fixerng.app / Vercel) and backend (onrender.com) are on
// different domains, so this cookie is genuinely cross-site. Modern
// browsers require SameSite=None to be paired with Secure — and Secure
// cookies are refused entirely over plain http, so in local dev (usually
// http://localhost) we fall back to SameSite=Lax and no Secure flag.
// Set NODE_ENV=production (Render does this by default) to get the real
// cross-site settings.
const isProduction = process.env.NODE_ENV === "production";

const COOKIE_NAME = "fixer_token";

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  maxAge: 24 * 60 * 60 * 1000, // 1 day — matches the JWT's own expiresIn
  path: "/",
};

module.exports = { COOKIE_NAME, cookieOptions };
