const { sha, safeEq, fail, parseCookies } = require("../lib/utils");
const { queries } = require("../db");

let dbRef = { owners: {}, rooms: {} };
let keyRef = "";

function setAuthContext(db, key) {
  if (db) dbRef = db;
  if (key) keyRef = key;
}

// --- Legacy owner auth (x-owner header) ---
const needOwner = (req, res, next) => {
  const h = sha(req.get("x-owner") || "none");
  const o = Object.values(dbRef.owners || {}).find(x => x.tokenHash === h || (x.more || []).includes(h));
  if (!o) return fail(res, 401, "Please sign in again.");
  req.o = o;
  next();
};

// --- Legacy responder auth (x-key header) ---
const needKey = (req, res, next) => {
  if (safeEq(req.get("x-key") || "", keyRef)) return next();
  return fail(res, 401, "Wrong responder key.");
};

const roomOf = req => {
  const h = sha(req.get("x-room") || "none");
  return Object.values(dbRef.rooms || {}).find(r => r.tokenHash && r.tokenHash === h);
};

const findTag = id => {
  const tid = String(id || "").toLowerCase();
  for (const o of Object.values(dbRef.owners || {})) {
    if (o.tags && Array.isArray(o.tags)) {
      const tag = o.tags.find(t => t.id && t.id.toLowerCase() === tid);
      if (tag) return { owner: o, tag };
    }
    if (o.qrId && o.qrId.toLowerCase() === tid) {
      return {
        owner: o,
        tag: { id: o.qrId, item: (o.pub && o.pub.itemName) || "My Belongings", active: o.qrActive !== false }
      };
    }
  }
  return null;
};

const tagOwner = id => {
  const hit = findTag(id);
  return hit ? hit.owner : null;
};

// --- New cookie-based community user auth ---
// optionalUser: attaches req.user if a valid session cookie exists, otherwise continues
const optionalUser = (req, res, next) => {
  req.user = null;
  const cookies = parseCookies(req);
  const token = cookies.tb_session;
  if (!token) return next();

  const tokenHash = sha(token);
  const user = queries.getUserBySessionHash(tokenHash);
  if (user && !user.banned) {
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      karma: user.karma,
      usernameChosen: !!user.username_chosen,
      createdAt: user.created_at
    };
  }
  next();
};

// requireUser: requires a valid session; returns 401 if not authenticated
const requireUser = (req, res, next) => {
  if (req.user) return next();
  // Try to resolve from cookie (in case optionalUser wasn't in the middleware chain)
  const cookies = parseCookies(req);
  const token = cookies.tb_session;
  if (!token) return fail(res, 401, "Sign in to continue.");

  const tokenHash = sha(token);
  const user = queries.getUserBySessionHash(tokenHash);
  if (!user) return fail(res, 401, "Session expired. Please sign in again.");
  if (user.banned) return fail(res, 403, "Your account has been suspended.");

  req.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    karma: user.karma,
    usernameChosen: !!user.username_chosen,
    createdAt: user.created_at
  };
  next();
};

// requireCommunityModerator: verifies user is owner or moderator of the community
const requireCommunityModerator = (communityParam = "name") => {
  return (req, res, next) => {
    requireUser(req, res, () => {
      const commName = req.params[communityParam];
      if (!commName) return fail(res, 400, "Community name is required.");
      if (req.user.role === "admin") return next();
      const role = queries.getUserCommunityRole(commName, req.user.id);
      if (role === "owner" || role === "moderator") {
        req.communityRole = role;
        return next();
      }
      return fail(res, 403, "You must be a moderator of c/" + commName + " to perform this action.");
    });
  };
};

// requireCommunityOwner: verifies user is owner of the community
const requireCommunityOwner = (communityParam = "name") => {
  return (req, res, next) => {
    requireUser(req, res, () => {
      const commName = req.params[communityParam];
      if (!commName) return fail(res, 400, "Community name is required.");
      if (req.user.role === "admin") return next();
      const role = queries.getUserCommunityRole(commName, req.user.id);
      if (role === "owner") {
        req.communityRole = role;
        return next();
      }
      return fail(res, 403, "Only the owner of c/" + commName + " can perform this action.");
    });
  };
};

// requireUploadAuth: allows Community users (cookie), Owners (x-owner header), or Finders (x-room header)
const requireUploadAuth = (req, res, next) => {
  // 1. Check Community user session from cookie
  const cookies = parseCookies(req);
  const token = cookies.tb_session;
  if (token) {
    const tokenHash = sha(token);
    const user = queries.getUserBySessionHash(tokenHash);
    if (user && !user.banned) {
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        karma: user.karma,
        usernameChosen: !!user.username_chosen,
        createdAt: user.created_at
      };
      return next();
    }
  }

  // 2. Check Owner auth (x-owner header)
  const oHeader = req.get("x-owner");
  if (oHeader) {
    const h = sha(oHeader);
    const o = Object.values(dbRef.owners || {}).find(x => x.tokenHash === h || (x.more || []).includes(h));
    if (o) {
      req.o = o;
      return next();
    }
  }

  // 3. Check Room auth (x-room header)
  const rHeader = req.get("x-room");
  if (rHeader) {
    const r = roomOf(req);
    if (r) {
      req.room = r;
      return next();
    }
  }

  return fail(res, 401, "Sign in or join conversation to upload photos.");
};

module.exports = {
  setAuthContext,
  needOwner,
  needKey,
  roomOf,
  tagOwner,
  findTag,
  optionalUser,
  requireUser,
  requireUploadAuth,
  requireCommunityModerator,
  requireCommunityOwner
};
