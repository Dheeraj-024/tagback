const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { requireUser } = require("../middleware/auth");
const { clip, fail } = require("../lib/utils");

// POST /api/comments/:id/vote - Upvote, downvote, or clear vote on a comment
router.post("/:id/vote", requireUser, (req, res) => {
  const dir = parseInt(req.body.direction, 10);
  if (![1, -1, 0].includes(dir)) {
    return fail(res, 400, "Vote direction must be 1 (up), -1 (down), or 0 (clear).");
  }

  try {
    const comment = queries.getCommentById(req.params.id);
    if (!comment) {
      return fail(res, 404, "Comment not found.");
    }
    const post = queries.getPostById(comment.post_id);
    if (post && queries.isUserBanned(post.communityName, req.user.id)) {
      return fail(res, 403, "You are banned from participating in this community.");
    }

    const result = queries.castVote({
      userId: req.user.id,
      targetType: "comment",
      targetId: req.params.id,
      direction: dir
    });

    if (!result) {
      return fail(res, 404, "Comment not found.");
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/comments/:id/vote error:", err);
    fail(res, 500, "Voting failed.");
  }
});

// PUT /api/comments/:id - Edit comment (author only)
router.put("/:id", requireUser, (req, res) => {
  const text = clip(req.body.text, 500);
  if (!text) {
    return fail(res, 400, "Text is required.");
  }

  try {
    const result = queries.editComment(req.params.id, req.user.id, text);
    if (result.error === "notFound") return fail(res, 404, "Comment not found.");
    if (result.error === "forbidden") return fail(res, 403, "You can only edit your own comments.");
    res.json(result);
  } catch (err) {
    console.error("PUT /api/comments/:id error:", err);
    fail(res, 500, "Failed to edit comment.");
  }
});

// DELETE /api/comments/:id - Soft-delete comment (author only)
router.delete("/:id", requireUser, (req, res) => {
  try {
    const result = queries.deleteComment(req.params.id, req.user.id);
    if (result.error === "notFound") return fail(res, 404, "Comment not found.");
    if (result.error === "forbidden") return fail(res, 403, "You can only delete your own comments.");
    res.json(result);
  } catch (err) {
    console.error("DELETE /api/comments/:id error:", err);
    fail(res, 500, "Failed to delete comment.");
  }
});

module.exports = router;
