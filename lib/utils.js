const crypto = require("crypto");

const rnd = n => crypto.randomBytes(n).toString("hex");
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const clip = (s, n) => String(s || "").trim().slice(0, n);
const cname = s => String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const safeEq = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest()
  );

// Reserved names that cannot be used as usernames or community names
const RESERVED_NAMES = new Set([
  "admin", "administrator", "mod", "moderator", "official",
  "pingme", "tagback", "support", "help", "system", "bot",
  "deleted", "removed", "anonymous", "guest", "staff",
  "root", "superuser", "null", "undefined", "api",
  "www", "mail", "email", "test", "debug", "info",
  "community", "communities", "post", "posts", "user", "users",
  "auth", "login", "logout", "register", "signup", "signin",
  "settings", "notifications", "search", "explore", "home",
  "about", "legal", "privacy", "terms", "contact"
]);

// Validate a username: 3-20 chars, lowercase alphanumeric + underscores, starts with letter
function validateUsername(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, error: "Username is required." };
  const name = raw.toLowerCase().trim();
  if (name.length < 3 || name.length > 20) return { ok: false, error: "Username must be 3–20 characters." };
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return { ok: false, error: "Username must start with a letter and contain only letters, numbers, and underscores." };
  if (RESERVED_NAMES.has(name)) return { ok: false, error: "That username is reserved." };
  return { ok: true, name };
}

// Parse cookies from request header (no dependency needed)
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(";").forEach(pair => {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        cookies[key] = decodeURIComponent(val);
      }
    });
  }
  return cookies;
}

// Set the session cookie on a response
function setSessionCookie(res, token, maxAgeSec) {
  const age = maxAgeSec || 365 * 24 * 60 * 60; // 1 year default
  const parts = [
    `tb_session=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${age}`
  ];
  // In production (behind proxy / HTTPS), add Secure flag
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "tb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

// URL-safe cursor pagination encoding/decoding
function encodeCursor(obj) {
  if (!obj) return null;
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function decodeCursor(str) {
  if (!str) return null;
  try {
    return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
}

// Emergency keyword detector (pure deterministic regex, no AI dependency)
const EMG = /\b(fire|baby|accident|help|ambulance|bleeding|unconscious|collapsed|heart attack|aag|bachao|hadsa|khoon|behosh)\b|आग|बचाओ|एम्बुलेंस|एंबुलेंस|दुर्घटना|हादसा|खून|बेहोश|ਅੱਗ|ਬਚਾਓ|ਐਂਬੂਲੈਂਸ|ਹਾਦਸਾ|ਖੂਨ|ਬੇਹੋਸ਼/i;
function isEmergency(text) {
  return EMG.test(String(text || ""));
}

// Spam detection regexes
const LINK_REGEX = /(?:https?:\/\/|www\.)[^\s]+|[a-zA-Z0-9-]+\.(?:com|org|net|in|io|co|app|xyz|dev|info|biz)\b/i;
const PHONE_REGEX = /(?:(?:\+|0{0,2})91[\s-]*)?[6789]\d{9}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|\b\d{10,12}\b/;

function containsLink(text) {
  return LINK_REGEX.test(String(text || ""));
}

function containsPhone(text) {
  return PHONE_REGEX.test(String(text || ""));
}

// Configurable thresholds for spam control
function getMinAccountAgeForLinks() {
  if (process.env.MIN_ACCOUNT_AGE_FOR_LINKS != null) {
    return parseInt(process.env.MIN_ACCOUNT_AGE_FOR_LINKS, 10);
  }
  return process.env.NODE_ENV === "production" ? 24 * 60 * 60 * 1000 : 0;
}

function getMinAccountAgeForCommunity() {
  if (process.env.MIN_ACCOUNT_AGE_FOR_COMMUNITY != null) {
    return parseInt(process.env.MIN_ACCOUNT_AGE_FOR_COMMUNITY, 10);
  }
  return process.env.NODE_ENV === "production" ? 60 * 60 * 1000 : 0;
}

function getPostCooldownMs() {
  if (process.env.POST_COOLDOWN_MS != null) {
    return parseInt(process.env.POST_COOLDOWN_MS, 10);
  }
  return process.env.NODE_ENV === "production" ? 30 * 1000 : 0;
}

const DUPLICATE_POST_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

module.exports = {
  rnd,
  sha,
  clip,
  cname,
  fail,
  safeEq,
  RESERVED_NAMES,
  validateUsername,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  encodeCursor,
  decodeCursor,
  EMG,
  isEmergency,
  containsLink,
  containsPhone,
  getMinAccountAgeForLinks,
  getMinAccountAgeForCommunity,
  getPostCooldownMs,
  DUPLICATE_POST_WINDOW_MS
};
