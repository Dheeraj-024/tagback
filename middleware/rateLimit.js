const { db } = require("../db");

// SQLite-backed sliding-window rate limiter (survives restarts)
const _countStmt = db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND ts >= ?");
const _insertStmt = db.prepare("INSERT INTO rate_limits (key, ts) VALUES (?, ?)");
const _cleanupStmt = db.prepare("DELETE FROM rate_limits WHERE ts < ?");

function limit(key, max, ms) {
  const now = Date.now();
  const cutoff = now - ms;
  const row = _countStmt.get(key, cutoff);
  if (row.n >= max) return false;
  _insertStmt.run(key, now);
  return true;
}

// Helper: build rate-limit key from request (per-user if authed, per-IP otherwise)
function rateKey(req, action) {
  if (req.user) return action + ":u:" + req.user.id;
  return action + ":ip:" + req.ip;
}

// Periodic cleanup of old entries (every 5 minutes)
setInterval(() => {
  try {
    _cleanupStmt.run(Date.now() - 3600e3);
  } catch (e) {
    // DB might be closed during shutdown
  }
}, 300e3).unref();

module.exports = { limit, rateKey };
