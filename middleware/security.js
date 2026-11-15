const { fail } = require("../lib/utils");

// Allowed origins configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim().toLowerCase())
  : null;

// Production security headers (Helmet equivalent, zero-dependency)
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME-sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Strict Transport Security (HSTS)
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  // Referrer Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Modern X-XSS-Protection header
  res.setHeader("X-XSS-Protection", "0");

  // Permissions Policy (restrict camera to self, disable microphone & geolocation)
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");

  // Content Security Policy (allows required CDNs for QR generator and fonts)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);

  next();
}

// CORS Middleware with origin validation
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  if (origin) {
    const normOrigin = origin.toLowerCase();
    const host = (req.headers.host || "").toLowerCase();
    const isSameHost = normOrigin.includes(host);

    if (ALLOWED_ORIGINS) {
      if (ALLOWED_ORIGINS.includes(normOrigin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } else if (isSameHost || normOrigin.includes("localhost") || normOrigin.includes("127.0.0.1")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, x-owner, x-room, x-key, x-tb-csrf"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
}

// CSRF Protection for state-changing requests using cookie auth
function csrfProtection(req, res, next) {
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Exempt endpoints that don't rely on cookie session authentication
  // (e.g. tag scanning, finder submission, anonymous webhook endpoints)
  if (req.headers["x-owner"] || req.headers["x-room"] || req.headers["x-key"]) {
    return next();
  }

  // If user has a cookie session, enforce CSRF defense
  const hasCookieSession = req.headers.cookie && req.headers.cookie.includes("tb_session=");
  if (!hasCookieSession) {
    return next();
  }

  // 1. Check Origin / Referer header against Host
  const host = (req.headers.host || "").toLowerCase();
  const origin = req.headers.origin ? req.headers.origin.toLowerCase() : null;
  const referer = req.headers.referer ? req.headers.referer.toLowerCase() : null;

  if (origin) {
    const isOriginMatch = origin.includes(host) ||
      (ALLOWED_ORIGINS && ALLOWED_ORIGINS.some(o => origin.startsWith(o))) ||
      origin.includes("localhost") || origin.includes("127.0.0.1");

    if (!isOriginMatch) {
      return fail(res, 403, "Cross-site request blocked (CSRF origin mismatch).");
    }
  } else if (referer) {
    const isRefererMatch = referer.includes(host) ||
      (ALLOWED_ORIGINS && ALLOWED_ORIGINS.some(o => referer.startsWith(o))) ||
      referer.includes("localhost") || referer.includes("127.0.0.1");

    if (!isRefererMatch) {
      return fail(res, 403, "Cross-site request blocked (CSRF referer mismatch).");
    }
  }

  next();
}

module.exports = {
  securityHeaders,
  corsMiddleware,
  csrfProtection
};

