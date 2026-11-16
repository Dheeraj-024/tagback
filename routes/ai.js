const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { limit, rateKey } = require("../middleware/rateLimit");
const { optionalUser } = require("../middleware/auth");
const { clip, fail } = require("../lib/utils");
const {
  parsePost,
  moderateContent,
  assistFinderMessage,
  suggestDealReplies,
  summarizeThread
} = require("../lib/ai");

// Rate limit: 40 AI queries per minute per user / IP
function aiRateLimit(req, res, next) {
  if (!limit(rateKey(req, "ai_req"), 40, 60e3)) {
    return fail(res, 429, "AI request limit reached. Please wait a moment.");
  }
  next();
}

// POST /api/ai/parse-post - Parse natural language into structured post fields and recommend best community
router.post("/parse-post", aiRateLimit, async (req, res) => {
  const text = clip(req.body.text || req.body.prompt, 500);
  if (!text || text.length < 3) {
    return fail(res, 400, "Please enter at least a few words describing your post.");
  }

  try {
    const communities = queries.getCommunities ? queries.getCommunities() : [];
    const parsed = await parsePost(text, communities);
    if (!parsed) {
      return fail(res, 500, "Unable to parse post content.");
    }
    res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error("POST /api/ai/parse-post error:", err);
    fail(res, 500, "AI parsing failed.");
  }
});

// POST /api/ai/finder-assist - Compose a courteous finder recovery message
router.post("/finder-assist", aiRateLimit, async (req, res) => {
  const itemName = clip(req.body.itemName || req.body.item, 60);
  const draft = clip(req.body.draft || req.body.notes || req.body.desc, 300);
  const ownerName = clip(req.body.ownerName || req.body.owner, 40);

  try {
    const message = await assistFinderMessage(itemName, draft, ownerName);
    res.json({ ok: true, message });
  } catch (err) {
    console.error("POST /api/ai/finder-assist error:", err);
    fail(res, 500, "Unable to generate message.");
  }
});

// POST /api/ai/suggest-replies - Quick response suggestions for deal chats
router.post("/suggest-replies", aiRateLimit, async (req, res) => {
  const postContext = {
    title: clip(req.body.title || req.body.postTitle, 100),
    postType: clip(req.body.postType, 20) || "NEED"
  };
  const lastMessages = Array.isArray(req.body.messages) ? req.body.messages.slice(-5) : [];
  const userRole = req.body.userRole || "author";

  try {
    const suggestions = await suggestDealReplies(postContext, lastMessages, userRole);
    res.json({ ok: true, suggestions });
  } catch (err) {
    console.error("POST /api/ai/suggest-replies error:", err);
    fail(res, 500, "Unable to generate suggestions.");
  }
});

// POST /api/ai/moderate - Check content safety
router.post("/moderate", aiRateLimit, async (req, res) => {
  const title = clip(req.body.title, 200);
  const body = clip(req.body.body, 1000);

  try {
    const result = await moderateContent(title, body);
    res.json({ ok: true, moderation: result });
  } catch (err) {
    console.error("POST /api/ai/moderate error:", err);
    fail(res, 500, "Moderation check failed.");
  }
});

// GET /api/ai/summary/:postId - Generate or retrieve thread summary
router.get("/summary/:postId", aiRateLimit, async (req, res) => {
  try {
    const post = queries.getPostById(req.params.postId);
    if (!post) {
      return fail(res, 404, "Post not found.");
    }
    const comments = queries.getCommentsForPost(post.id) || [];
    const summary = await summarizeThread(post.title, comments);
    res.json({ ok: true, summary, commentCount: comments.length });
  } catch (err) {
    console.error("GET /api/ai/summary error:", err);
    fail(res, 500, "Failed to summarize discussion.");
  }
});

module.exports = router;

