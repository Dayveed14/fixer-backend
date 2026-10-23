/* ===========================
   SESSION STATE
   JWTs can't be "taken back" on their own. Each user has a
   token_version; tokens carry the version they were issued with
   ("tv"). Changing the password bumps the version, which ends every
   other session. A role change or a deleted account also ends
   sessions.

   Looked up on each authenticated request, cached for 60 s so it
   costs at most one small query per user per minute.
=========================== */

const db = require("../config/db");

const CACHE_MS = 60 * 1000;
const cache = new Map();

/** { version, role } for a user, or null if the account no longer exists. */
async function getSessionState(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;

  let rows;
  try {
    [rows] = await db.query("SELECT token_version, role FROM users WHERE id = ?", [userId]);
  } catch (err) {
    // Before the migration adds token_version: fall back to role only.
    if (err.code !== "ER_BAD_FIELD_ERROR") throw err;
    [rows] = await db.query("SELECT role FROM users WHERE id = ?", [userId]);
  }

  const row = rows && rows[0];
  // No token_version column yet → only the role is enforced.
  const state = row
    ? { role: row.role, ...("token_version" in row ? { version: Number(row.token_version) || 0 } : {}) }
    : null;
  cache.set(userId, { state, at: Date.now() });
  return state;
}

function invalidateSession(userId) {
  cache.delete(userId);
}

function clearSessionCache() {
  cache.clear();
}

module.exports = { getSessionState, invalidateSession, clearSessionCache };
