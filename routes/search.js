const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { clip, fail } = require("../lib/utils");

// GET /api/search?q=query&type=all|communities|posts
router.get("/", (req, res) => {
  const q = clip(req.query.q, 100);
  if (!q || q.length < 2) {
    return fail(res, 400, "Search query must be at least 2 characters.");
  }

  const type = ["all", "communities", "posts"].includes(req.query.type) ? req.query.type : "all";
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  try {
    const results = queries.search({ q, type, limit });
    res.json(results);
  } catch (err) {
    console.error("GET /api/search error:", err);
    fail(res, 500, "Search failed.");
  }
});

module.exports = router;

