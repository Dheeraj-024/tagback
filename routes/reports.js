const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { requireUser } = require("../middleware/auth");
const { eventBus } = require("../lib/events");
const { clip, rnd, fail } = require("../lib/utils");

// POST /api/reports - Report a post or comment
router.post("/", requireUser, (req, res) => {
  const targetType = req.body.target_type || req.body.targetType;
  const targetId = req.body.target_id || req.body.targetId;
  const reason = clip(req.body.reason, 200);

  if (!["post", "comment"].includes(targetType)) {
    return fail(res, 400, "Target type must be 'post' or 'comment'.");
  }
  if (!targetId) {
    return fail(res, 400, "Target ID is required.");
  }
  if (!reason) {
    return fail(res, 400, "Please provide a reason for the report.");
  }

  let communityName = null;
  if (targetType === "post") {
    const post = queries.getPostById(targetId);
    if (!post) return fail(res, 404, "Post not found.");
    communityName = post.communityName;
  } else {
    const comment = queries.getCommentById(targetId);
    if (!comment) return fail(res, 404, "Comment not found.");
    const post = queries.getPostById(comment.post_id);
    if (!post) return fail(res, 404, "Associated post not found.");
    communityName = post.communityName;
  }

  const id = rnd(6);
  try {
    const report = queries.createReport({
      id,
      reporterId: req.user.id,
      targetType,
      targetId,
      communityName,
      reason
    });

    // Notify community moderators
    const modsData = queries.getCommunityModerators(communityName);
    if (modsData && Array.isArray(modsData.moderators)) {
      for (const m of modsData.moderators) {
        if (m.user_id !== req.user.id) {
          const notif = queries.createNotification({
            userId: m.user_id,
            type: "mod_action",
            title: `New report in c/${communityName}`,
            body: `A ${targetType} was reported: "${clip(reason, 80)}"`,
            link: `/communities/${communityName}`
          });
          eventBus.emitNotification(m.user_id, notif);
        }
      }
    }

    res.json({ ok: true, report });
  } catch (err) {
    console.error("POST /api/reports error:", err);
    fail(res, 500, "Failed to submit report.");
  }
});

module.exports = router;

