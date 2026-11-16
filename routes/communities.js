const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { limit, rateKey } = require("../middleware/rateLimit");
const { requireUser, requireCommunityModerator, requireCommunityOwner } = require("../middleware/auth");
const { eventBus } = require("../lib/events");
const {
  clip,
  cname,
  rnd,
  fail,
  RESERVED_NAMES,
  encodeCursor,
  decodeCursor,
  isEmergency,
  containsLink,
  containsPhone,
  getMinAccountAgeForLinks,
  getMinAccountAgeForCommunity,
  getPostCooldownMs,
  DUPLICATE_POST_WINDOW_MS
} = require("../lib/utils");
const { moderateContent } = require("../lib/ai");

// GET /api/communities - List all communities with post & member counts
router.get("/", (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const city = req.query.city ? clip(req.query.city, 50) : null;
    const list = queries.getCommunities(userId, city);
    res.json(list);
  } catch (err) {
    console.error("GET /api/communities error:", err);
    fail(res, 500, "Unable to load communities.");
  }
});

// GET /api/communities/joined - List communities joined by current user (auth required)
router.get("/joined", requireUser, (req, res) => {
  try {
    const list = queries.getJoinedCommunities(req.user.id);
    res.json(list);
  } catch (err) {
    console.error("GET /api/communities/joined error:", err);
    fail(res, 500, "Unable to load joined communities.");
  }
});

// POST /api/communities - Create a new community (auth required)
router.post("/", requireUser, (req, res) => {
  if (queries.isUserBanned(null, req.user.id)) {
    return fail(res, 403, "Your account has been suspended.");
  }

  // Spam control: Minimum account age to create communities
  const minCommAge = getMinAccountAgeForCommunity();
  const accountAge = Date.now() - (req.user.createdAt || 0);
  if (minCommAge > 0 && accountAge < minCommAge) {
    const waitMin = Math.ceil((minCommAge - accountAge) / 60000);
    return fail(res, 403, `Account too new to create communities. Please wait ${waitMin} more minute(s).`);
  }

  if (!limit(rateKey(req, "cc"), 5, 3600e3)) {
    return fail(res, 429, "Too many communities created. Try later.");
  }
  const name = cname(req.body.name);
  if (name.length < 3) {
    return fail(res, 400, "Name needs 3+ letters, numbers or underscores (e.g. cabs_city).");
  }
  if (RESERVED_NAMES.has(name)) {
    return fail(res, 400, "That name is reserved.");
  }
  if (queries.getCommunity(name)) {
    return fail(res, 409, "That community already exists.");
  }

  const desc = clip(req.body.desc, 150);
  const city = clip(req.body.city, 50);
  try {
    queries.createCommunity({
      name,
      description: desc,
      city,
      createdBy: req.user.username,
      userId: req.user.id
    });
    res.json({ name, city });
  } catch (err) {
    console.error("POST /api/communities error:", err);
    fail(res, 500, "Failed to create community.");
  }
});

// GET /api/communities/:name - Get single community info
router.get("/:name", (req, res) => {
  const n = cname(req.params.name);
  const userId = req.user ? req.user.id : null;
  const community = queries.getCommunity(n, userId);
  if (!community) {
    return fail(res, 404, "Unknown community.");
  }
  const userRole = userId ? queries.getUserCommunityRole(n, userId) : null;
  res.json({ ...community, userRole });
});

// POST /api/communities/:name/join - Join a community (auth required)
router.post("/:name/join", requireUser, (req, res) => {
  const n = cname(req.params.name);
  if (queries.isUserBanned(n, req.user.id)) {
    return fail(res, 403, "You are banned from this community.");
  }
  const result = queries.joinCommunity(n, req.user.id);
  if (!result) return fail(res, 404, "Unknown community.");
  res.json(result);
});

// POST /api/communities/:name/leave - Leave a community (auth required)
router.post("/:name/leave", requireUser, (req, res) => {
  const n = cname(req.params.name);
  const result = queries.leaveCommunity(n, req.user.id);
  if (!result) return fail(res, 404, "Unknown community.");
  res.json(result);
});

// GET /api/communities/:name/posts - List posts with Hot/New/Top sorting and cursor pagination
router.get("/:name/posts", (req, res) => {
  const n = cname(req.params.name);
  const userId = req.user ? req.user.id : null;
  const community = queries.getCommunity(n, userId);
  if (!community) {
    return fail(res, 404, "Unknown community.");
  }

  const userRole = userId ? queries.getUserCommunityRole(n, userId) : null;
  const sort = ["hot", "new", "top"].includes(req.query.sort) ? req.query.sort : "hot";
  const t = ["day", "week", "month", "all"].includes(req.query.t) ? req.query.t : "all";
  const type = req.query.type ? clip(req.query.type, 10).toUpperCase() : null;
  const status = req.query.status ? clip(req.query.status, 20).toLowerCase() : null;
  const city = req.query.city ? clip(req.query.city, 50) : null;
  const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

  const decodedCursor = decodeCursor(req.query.cursor);
  const page = req.query.page ? parseInt(req.query.page, 10) : null;

  try {
    const result = queries.getPostsForCommunity(n, {
      sort,
      t,
      cursor: decodedCursor,
      page,
      limit: lim,
      userId,
      type,
      status,
      city
    });

    const nextCursorEncoded = result.nextCursor ? encodeCursor(result.nextCursor) : null;

    res.json({
      community: {
        name: community.name,
        desc: community.desc,
        city: community.city,
        rules: community.rules,
        by: community.by,
        t: community.t,
        members: community.members,
        joined: community.joined,
        userRole
      },
      posts: result.posts.map(p => ({
        id: p.id,
        title: p.title,
        body: p.body,
        nick: p.authorNick,
        userId: p.userId,
        authorTrust: p.authorTrust,
        postType: p.postType,
        status: p.status,
        budget: p.budget,
        targetTime: p.targetTime,
        location: p.location,
        city: p.city,
        t: p.createdAt,
        comments: p.commentCount,
        score: p.score,
        upvotes: p.upvotes,
        downvotes: p.downvotes,
        userVote: p.userVote,
        deleted: p.deleted
      })),
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasMore: result.hasMore,
        nextCursor: nextCursorEncoded,
        sort,
        t,
        type,
        status,
        city
      }
    });
  } catch (err) {
    console.error("GET /api/communities/:name/posts error:", err);
    fail(res, 500, "Unable to load posts.");
  }
});

// POST /api/communities/:name/posts - Create a new post (auth required)
router.post("/:name/posts", requireUser, async (req, res) => {
  const n = cname(req.params.name);
  const community = queries.getCommunity(n);
  if (!community) {
    return fail(res, 404, "Unknown community.");
  }

  // Moderation check: Banned user
  if (queries.isUserBanned(n, req.user.id)) {
    return fail(res, 403, "You are banned from participating in this community.");
  }

  const title = clip(req.body.title, 100);
  const body = clip(req.body.body, 500);
  if (!title) {
    return fail(res, 400, "Add a title for your need.");
  }

  // Spam control 1: Block phone numbers and external links for accounts younger than set age
  const minLinkAge = getMinAccountAgeForLinks();
  const accountAge = Date.now() - (req.user.createdAt || 0);
  if (minLinkAge > 0 && accountAge < minLinkAge) {
    if (containsLink(title) || containsLink(body)) {
      return fail(res, 403, "New accounts (under 24 hours old) cannot post external links.");
    }
    if (containsPhone(title) || containsPhone(body)) {
      return fail(res, 403, "New accounts (under 24 hours old) cannot post phone numbers.");
    }
  }

  // Spam control 2: Cooldown & Duplicate detection
  const cooldownMs = getPostCooldownMs();
  const postCheck = queries.checkRecentPost({
    userId: req.user.id,
    title,
    body,
    cooldownMs,
    duplicateWindowMs: DUPLICATE_POST_WINDOW_MS
  });

  if (postCheck.error === "cooldown") {
    return fail(res, 429, `Please wait ${postCheck.remainingSec} second(s) before posting again.`);
  }
  if (postCheck.error === "duplicate") {
    return fail(res, 400, "Duplicate post detected. You recently posted an identical request.");
  }

  if (!limit(rateKey(req, "post"), 10, 60e3)) {
    return fail(res, 429, "Slow down a little.");
  }

  // Automated AI & scam moderation check
  const modCheck = await moderateContent(title, body);
  if (modCheck && modCheck.flagAction === "block") {
    return fail(res, 400, "Safety alert: " + (modCheck.reason || "Suspicious or unsafe content detected."));
  }

  // Emergency rule check (fixed keyword regex, no AI dependency)
  const isEmg = isEmergency(title) || isEmergency(body);

  const postType = (req.body.post_type || req.body.postType || "NEED").toUpperCase();
  const budget = req.body.budget != null ? clip(req.body.budget, 50) : null;
  const targetTime = clip(req.body.target_time || req.body.targetTime, 50);
  const location = clip(req.body.location, 100);
  const city = clip(req.body.city || community.city, 50);
  const imageUrl = clip(req.body.imageUrl || req.body.image_url, 250);

  const id = rnd(4);

  try {
    const newPost = queries.createPost({
      id,
      communityName: n,
      userId: req.user.id,
      authorNick: req.user.username,
      title,
      body,
      postType,
      budget,
      targetTime,
      location,
      city,
      imageUrl
    });
    res.json({
      id,
      postType: newPost.postType,
      status: newPost.status,
      budget: newPost.budget,
      targetTime: newPost.targetTime,
      location: newPost.location,
      city: newPost.city,
      imageUrl: newPost.imageUrl,
      emergency: isEmg,
      call112: isEmg,
      message: isEmg ? "EMERGENCY: Immediate crisis keywords detected. Please Call 112 now." : undefined
    });
  } catch (err) {
    console.error("POST /api/communities/:name/posts error:", err);
    fail(res, 500, "Failed to create post.");
  }
});

// PUT /api/communities/:name/rules - Update community rules (owner / moderator only)
router.put("/:name/rules", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  const rules = clip(req.body.rules, 1000);
  try {
    const result = queries.updateCommunityRules({
      communityName: n,
      rules,
      updatedBy: req.user.id
    });
    res.json(result);
  } catch (err) {
    console.error("PUT /api/communities/:name/rules error:", err);
    fail(res, 500, "Failed to update community rules.");
  }
});

// GET /api/communities/:name/moderators - List community owner and moderators
router.get("/:name/moderators", (req, res) => {
  const n = cname(req.params.name);
  try {
    const mods = queries.getCommunityModerators(n);
    res.json(mods);
  } catch (err) {
    console.error("GET /api/communities/:name/moderators error:", err);
    fail(res, 500, "Unable to load moderators.");
  }
});

// POST /api/communities/:name/moderators - Appoint a moderator (owner only)
router.post("/:name/moderators", requireCommunityOwner("name"), (req, res) => {
  const n = cname(req.params.name);
  const targetUsername = clip(req.body.username, 30).toLowerCase();
  if (!targetUsername) return fail(res, 400, "Username is required.");

  const targetUser = queries.getUserByUsername(targetUsername);
  if (!targetUser) return fail(res, 404, "User not found.");

  try {
    const result = queries.setModerator({
      communityName: n,
      userId: targetUser.id,
      appointedBy: req.user.id
    });
    res.json({ ok: true, username: targetUser.username, role: result.role });
  } catch (err) {
    console.error("POST /api/communities/:name/moderators error:", err);
    fail(res, 500, "Failed to appoint moderator.");
  }
});

// DELETE /api/communities/:name/moderators/:username - Remove a moderator (owner only)
router.delete("/:name/moderators/:username", requireCommunityOwner("name"), (req, res) => {
  const n = cname(req.params.name);
  const targetUsername = clip(req.params.username, 30).toLowerCase();
  const targetUser = queries.getUserByUsername(targetUsername);
  if (!targetUser) return fail(res, 404, "User not found.");

  try {
    const result = queries.removeModerator({
      communityName: n,
      userId: targetUser.id,
      removedBy: req.user.id
    });
    res.json({ ok: true, username: targetUser.username, role: result.role });
  } catch (err) {
    console.error("DELETE /api/communities/:name/moderators/:username error:", err);
    fail(res, 500, "Failed to remove moderator.");
  }
});

// GET /api/communities/:name/mod/reports - View reported content in mod queue
router.get("/:name/mod/reports", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  const status = req.query.status || "pending";
  try {
    const reports = queries.getReportsForCommunity(n, status);
    res.json(reports);
  } catch (err) {
    console.error("GET /api/communities/:name/mod/reports error:", err);
    fail(res, 500, "Failed to load mod queue.");
  }
});

// POST /api/communities/:name/mod/reports/:id/dismiss - Dismiss report
router.post("/:name/mod/reports/:id/dismiss", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  try {
    const result = queries.dismissReport({
      reportId: req.params.id,
      communityName: n,
      moderatorId: req.user.id
    });
    if (result.error === "notFound") return fail(res, 404, "Report not found.");
    res.json(result);
  } catch (err) {
    console.error("POST /api/communities/:name/mod/reports/:id/dismiss error:", err);
    fail(res, 500, "Failed to dismiss report.");
  }
});

// POST /api/communities/:name/mod/reports/:id/remove - Remove reported content
router.post("/:name/mod/reports/:id/remove", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  try {
    const result = queries.resolveReportWithRemove({
      reportId: req.params.id,
      communityName: n,
      moderatorId: req.user.id
    });
    if (result.error === "notFound") return fail(res, 404, "Report not found.");
    res.json(result);
  } catch (err) {
    console.error("POST /api/communities/:name/mod/reports/:id/remove error:", err);
    fail(res, 500, "Failed to remove content.");
  }
});

// POST /api/communities/:name/mod/ban - Ban user from community
router.post("/:name/mod/ban", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  const targetUsername = clip(req.body.username, 30).toLowerCase();
  const userId = req.body.userId;
  const reason = clip(req.body.reason, 200);

  let targetUser = null;
  if (userId) targetUser = queries.getUserById(userId);
  else if (targetUsername) targetUser = queries.getUserByUsername(targetUsername);

  if (!targetUser) return fail(res, 404, "User not found.");

  // Cannot ban the owner
  const role = queries.getUserCommunityRole(n, targetUser.id);
  if (role === "owner") {
    return fail(res, 400, "Cannot ban the community owner.");
  }

  try {
    const result = queries.banUser({
      communityName: n,
      userId: targetUser.id,
      bannedBy: req.user.id,
      reason,
      global: !!req.body.global
    });

    const notif = queries.createNotification({
      userId: targetUser.id,
      type: "mod_action",
      title: `You have been banned from c/${n}`,
      body: reason ? `Reason: ${reason}` : "Violation of community rules.",
      link: `/communities/${n}`
    });
    eventBus.emitNotification(targetUser.id, notif);

    res.json(result);
  } catch (err) {
    console.error("POST /api/communities/:name/mod/ban error:", err);
    fail(res, 500, "Failed to ban user.");
  }
});

// POST /api/communities/:name/mod/unban - Unban user from community
router.post("/:name/mod/unban", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  const targetUsername = clip(req.body.username, 30).toLowerCase();
  const userId = req.body.userId;

  let targetUser = null;
  if (userId) targetUser = queries.getUserById(userId);
  else if (targetUsername) targetUser = queries.getUserByUsername(targetUsername);

  if (!targetUser) return fail(res, 404, "User not found.");

  try {
    const result = queries.unbanUser({
      communityName: n,
      userId: targetUser.id,
      moderatorId: req.user.id
    });
    res.json(result);
  } catch (err) {
    console.error("POST /api/communities/:name/mod/unban error:", err);
    fail(res, 500, "Failed to unban user.");
  }
});

// GET /api/communities/:name/mod/logs - Mod audit logs
router.get("/:name/mod/logs", requireCommunityModerator("name"), (req, res) => {
  const n = cname(req.params.name);
  const limit = parseInt(req.query.limit, 10) || 50;
  try {
    const logs = queries.getModLogs(n, limit);
    res.json(logs);
  } catch (err) {
    console.error("GET /api/communities/:name/mod/logs error:", err);
    fail(res, 500, "Failed to load audit logs.");
  }
});

module.exports = router;

module.exports = router;
