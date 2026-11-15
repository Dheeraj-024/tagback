const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { limit, rateKey } = require("../middleware/rateLimit");
const { requireUser } = require("../middleware/auth");
const { rnd, sha, clip, fail, validateUsername, setSessionCookie, clearSessionCookie } = require("../lib/utils");

// POST /api/auth/register - Create anonymous device account
// Body: { username?: string }
// If username is omitted, generates one like "user_abc123"
router.post("/register", (req, res) => {
  if (!limit("reg:ip:" + req.ip, 10, 3600e3)) {
    return fail(res, 429, "Too many sign-ups. Try later.");
  }

  let username;
  let usernameChosen = false;
  const rawUsername = clip(req.body.username, 20);

  if (rawUsername) {
    const v = validateUsername(rawUsername);
    if (!v.ok) return fail(res, 400, v.error);
    username = v.name;
    usernameChosen = true;
    // Check uniqueness
    if (queries.getUserByUsername(username)) {
      return fail(res, 409, "That username is already taken.");
    }
  } else {
    // Generate anonymous username: user_<8 hex chars>
    username = "user_" + rnd(4);
    // Extremely unlikely collision, but check
    while (queries.getUserByUsername(username)) {
      username = "user_" + rnd(4);
    }
  }

  const userId = rnd(8);
  const recovery = rnd(8);
  const recoveryHash = sha(recovery.toLowerCase());
  const sessionToken = rnd(24);
  const sessionHash = sha(sessionToken);

  try {
    queries.createUser({ id: userId, username, recoveryHash, usernameChosen });
    queries.createSession({ tokenHash: sessionHash, userId });
    setSessionCookie(res, sessionToken);

    res.json({
      user: {
        id: userId,
        username,
        usernameChosen,
        role: "user",
        karma: 0
      },
      recovery
    });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    fail(res, 500, "Registration failed.");
  }
});

// POST /api/auth/login - Recover account with recovery key
// Body: { recovery: string }
router.post("/login", (req, res) => {
  if (!limit("login:ip:" + req.ip, 10, 3600e3)) {
    return fail(res, 429, "Too many attempts. Try later.");
  }

  const key = clip(req.body.recovery, 40);
  if (!key) return fail(res, 400, "Recovery key is required.");

  const hash = sha(key.toLowerCase());
  const user = queries.getUserByRecoveryHash(hash);
  if (!user) return fail(res, 401, "That recovery key isn't valid.");
  if (user.banned) return fail(res, 403, "This account has been suspended.");

  const sessionToken = rnd(24);
  const sessionHash = sha(sessionToken);

  try {
    queries.createSession({ tokenHash: sessionHash, userId: user.id });
    setSessionCookie(res, sessionToken);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        usernameChosen: !!user.username_chosen,
        role: user.role,
        karma: user.karma
      }
    });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    fail(res, 500, "Login failed.");
  }
});

// POST /api/auth/username - Choose a permanent username (one-time)
// Body: { username: string }
router.post("/username", requireUser, (req, res) => {
  if (req.user.usernameChosen) {
    return fail(res, 409, "You've already chosen your username. It can't be changed.");
  }

  const raw = clip(req.body.username, 20);
  const v = validateUsername(raw);
  if (!v.ok) return fail(res, 400, v.error);

  if (queries.getUserByUsername(v.name)) {
    return fail(res, 409, "That username is already taken.");
  }

  try {
    queries.updateUsername(req.user.id, v.name);
    req.user.username = v.name;
    req.user.usernameChosen = true;
    res.json({ user: { ...req.user } });
  } catch (err) {
    console.error("POST /api/auth/username error:", err);
    fail(res, 500, "Failed to update username.");
  }
});

// POST /api/auth/recovery - Generate a new recovery key
router.post("/recovery", requireUser, (req, res) => {
  const recovery = rnd(8);
  const hash = sha(recovery.toLowerCase());
  try {
    require("../db").db.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").run(hash, req.user.id);
    res.json({ recovery });
  } catch (err) {
    console.error("POST /api/auth/recovery error:", err);
    fail(res, 500, "Failed to generate recovery key.");
  }
});

// GET /api/auth/me - Get current user info
router.get("/me", requireUser, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout - Clear session
router.post("/logout", (req, res) => {
  const { parseCookies } = require("../lib/utils");
  const cookies = parseCookies(req);
  const token = cookies.tb_session;
  if (token) {
    try {
      queries.deleteSession(sha(token));
    } catch (e) { /* ignore */ }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;

