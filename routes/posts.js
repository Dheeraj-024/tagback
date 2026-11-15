const express = require("express");
const router = express.Router();
const { queries, buildCommentTree } = require("../db");
const { limit, rateKey } = require("../middleware/rateLimit");
const { requireUser } = require("../middleware/auth");
const { eventBus } = require("../lib/events");
const { clip, rnd, fail, containsLink, containsPhone, getMinAccountAgeForLinks } = require("../lib/utils");

// GET /api/posts/:id - Get a post with its comments
router.get("/:id", (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const post = queries.getPostById(req.params.id, userId);
    if (!post) {
      return fail(res, 404, "Post not found.");
    }
    const comments = queries.getCommentsForPost(post.id, { userId });
    const commentTree = buildCommentTree(comments);

    res.json({
      id: post.id,
      comm: post.communityName,
      title: post.title,
      body: post.body,
      nick: post.authorNick,
      userId: post.userId,
      authorTrust: post.authorTrust,
      postType: post.postType,
      status: post.status,
      budget: post.budget,
      targetTime: post.targetTime,
      location: post.location,
      city: post.city,
      imageUrl: post.imageUrl || null,
      t: post.createdAt,
      updatedAt: post.updatedAt,
      score: post.score,
      upvotes: post.upvotes,
      downvotes: post.downvotes,
      userVote: post.userVote,
      deleted: post.deleted,
      // Flat list for backward compatibility
      comments: comments.map(c => ({
        id: c.id,
        parentId: c.parentId,
        nick: c.authorNick,
        userId: c.userId,
        authorTrust: c.authorTrust,
        text: c.body,
        depth: c.depth,
        score: c.score,
        upvotes: c.upvotes,
        downvotes: c.downvotes,
        userVote: c.userVote,
        deleted: c.deleted,
        t: c.createdAt
      })),
      // Hierarchical tree for nested views
      commentTree
    });
  } catch (err) {
    console.error("GET /api/posts/:id error:", err);
    fail(res, 500, "Unable to load post.");
  }
});

// GET /api/posts/:id/stream - SSE endpoint for live comments
router.get("/:id/stream", (req, res) => {
  const post = queries.getPostById(req.params.id);
  if (!post) {
    return fail(res, 404, "Post not found.");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders && res.flushHeaders();

  const onComment = (comment) => {
    try {
      res.write(eventBus.formatSSE("comment", comment));
    } catch (e) {}
  };

  const channel = `post:${req.params.id}:comment`;
  eventBus.on(channel, onComment);

  const pingInterval = setInterval(() => {
    eventBus.sendKeepAlive(res);
  }, 20000);

  req.on("close", () => {
    clearInterval(pingInterval);
    eventBus.removeListener(channel, onComment);
  });
});

// POST /api/posts/:id/comments - Add a reply/comment (supports nested comments via parent_id)
router.post("/:id/comments", requireUser, (req, res) => {
  try {
    const post = queries.getPostById(req.params.id);
    if (!post) {
      return fail(res, 404, "Post not found.");
    }

    if (queries.isUserBanned(post.communityName, req.user.id)) {
      return fail(res, 403, "You are banned from participating in this community.");
    }

    if (!limit(rateKey(req, "cm"), 20, 60e3)) {
      return fail(res, 429, "Slow down a little.");
    }

    const text = clip(req.body.text, 500);
    if (!text) {
      return fail(res, 400, "Write a reply first.");
    }

    // Spam control: block links/phone for new accounts (<24h)
    const minLinkAge = getMinAccountAgeForLinks();
    const accountAge = Date.now() - (req.user.createdAt || 0);
    if (minLinkAge > 0 && accountAge < minLinkAge) {
      if (containsLink(text)) {
        return fail(res, 403, "New accounts (under 24 hours old) cannot post external links.");
      }
      if (containsPhone(text)) {
        return fail(res, 403, "New accounts (under 24 hours old) cannot post phone numbers.");
      }
    }

    const parentId = req.body.parent_id || req.body.parentId || null;
    const commentId = rnd(4);

    const comment = queries.createComment({
      id: commentId,
      postId: post.id,
      parentId,
      userId: req.user.id,
      authorNick: req.user.username,
      body: text
    });

    const commentData = {
      id: comment.id,
      postId: comment.postId,
      parentId: comment.parentId,
      userId: comment.userId,
      nick: comment.authorNick,
      text: comment.body,
      depth: comment.depth,
      score: 0,
      t: comment.createdAt
    };

    // Live broadcast to post viewers via SSE
    eventBus.emitPostComment(post.id, commentData);

    // In-app notifications for replies
    if (parentId) {
      const parentComment = queries.getCommentById(parentId);
      if (parentComment && parentComment.user_id && parentComment.user_id !== req.user.id) {
        const notif = queries.createNotification({
          userId: parentComment.user_id,
          type: "reply",
          title: `u/${req.user.username} replied to your comment`,
          body: clip(comment.body, 120),
          link: `/posts/${post.id}`
        });
        eventBus.emitNotification(parentComment.user_id, notif);
      }
    } else {
      if (post.userId && post.userId !== req.user.id) {
        const notif = queries.createNotification({
          userId: post.userId,
          type: "reply",
          title: `u/${req.user.username} replied to your post`,
          body: clip(comment.body, 120),
          link: `/posts/${post.id}`
        });
        eventBus.emitNotification(post.userId, notif);
      }
    }

    res.json({
      ok: true,
      id: comment.id,
      depth: comment.depth,
      comment: commentData
    });
  } catch (err) {
    console.error("POST /api/posts/:id/comments error:", err);
    if (err.statusCode === 400 || (err.message && (err.message.includes("depth") || err.message.includes("Parent")))) {
      return fail(res, 400, err.message);
    }
    fail(res, 500, err.message || "Failed to submit reply.");
  }
});

// POST /api/posts/:id/vote - Upvote, downvote, or clear vote on a post
router.post("/:id/vote", requireUser, (req, res) => {
  const dir = parseInt(req.body.direction, 10);
  if (![1, -1, 0].includes(dir)) {
    return fail(res, 400, "Vote direction must be 1 (up), -1 (down), or 0 (clear).");
  }

  try {
    const post = queries.getPostById(req.params.id);
    if (!post) {
      return fail(res, 404, "Post not found.");
    }

    if (queries.isUserBanned(post.communityName, req.user.id)) {
      return fail(res, 403, "You are banned from participating in this community.");
    }

    const result = queries.castVote({
      userId: req.user.id,
      targetType: "post",
      targetId: req.params.id,
      direction: dir
    });

    if (!result) {
      return fail(res, 404, "Post not found.");
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/posts/:id/vote error:", err);
    fail(res, 500, "Voting failed.");
  }
});

// PUT /api/posts/:id - Edit post (author only)
router.put("/:id", requireUser, (req, res) => {
  const title = clip(req.body.title, 100);
  const body = clip(req.body.body, 500);
  if (!title) {
    return fail(res, 400, "Title is required.");
  }

  try {
    const result = queries.editPost(req.params.id, req.user.id, { title, body });
    if (result.error === "notFound") return fail(res, 404, "Post not found.");
    if (result.error === "forbidden") return fail(res, 403, "You can only edit your own posts.");
    res.json(result);
  } catch (err) {
    console.error("PUT /api/posts/:id error:", err);
    fail(res, 500, "Failed to edit post.");
  }
});

// DELETE /api/posts/:id - Soft-delete post (author only)
router.delete("/:id", requireUser, (req, res) => {
  try {
    const result = queries.deletePost(req.params.id, req.user.id);
    if (result.error === "notFound") return fail(res, 404, "Post not found.");
    if (result.error === "forbidden") return fail(res, 403, "You can only delete your own posts.");
    res.json(result);
  } catch (err) {
    console.error("DELETE /api/posts/:id error:", err);
    fail(res, 500, "Failed to delete post.");
  }
});

// PATCH /api/posts/:id/status - Update post status (open, in_progress, fulfilled, expired)
router.patch("/:id/status", requireUser, (req, res) => {
  const status = clip(req.body.status, 20).toLowerCase();
  const valid = ["open", "in_progress", "fulfilled", "expired"];
  if (!valid.includes(status)) {
    return fail(res, 400, "Invalid status. Must be one of: " + valid.join(", "));
  }

  try {
    const result = queries.updatePostStatus(req.params.id, req.user.id, status);
    if (result.error === "notFound") return fail(res, 404, "Post not found.");
    if (result.error === "forbidden") return fail(res, 403, "Only the author or a moderator can update post status.");
    res.json(result);
  } catch (err) {
    console.error("PATCH /api/posts/:id/status error:", err);
    fail(res, 500, "Failed to update status.");
  }
});

// POST /api/posts/:id/accept-offer - Accept an offer, transitioning post to in_progress and creating private deal chat
router.post("/:id/accept-offer", requireUser, (req, res) => {
  try {
    let helperId = req.body.helper_id || req.body.helperId;
    const commentId = req.body.comment_id || req.body.commentId;

    if (!helperId && commentId) {
      const comment = queries.getCommentById(commentId);
      if (!comment) return fail(res, 404, "Comment not found.");
      helperId = comment.user_id;
    }

    if (!helperId) {
      return fail(res, 400, "Helper user ID or comment ID is required to accept an offer.");
    }

    const result = queries.createDealChat({
      postId: req.params.id,
      authorId: req.user.id,
      helperId
    });

    if (result.error === "notFound") return fail(res, 404, result.message || "Not found.");
    if (result.error === "forbidden") return fail(res, 403, result.message || "Only the author can accept an offer.");
    if (result.error === "badRequest") return fail(res, 400, result.message || "Cannot accept own offer.");

    const dealId = result.dealId || (result.chat ? result.chat.id : null);

    // Notify helper about accepted offer
    if (!result.existing && dealId) {
      const post = queries.getPostById(req.params.id);
      const postTitle = post ? post.title : "your offer";
      const notif = queries.createNotification({
        userId: helperId,
        type: "accepted_offer",
        title: "Your offer was accepted!",
        body: `u/${req.user.username} accepted your offer on "${clip(postTitle, 60)}". A private deal chat is now open.`,
        link: `/deals/${dealId}`
      });
      eventBus.emitNotification(helperId, notif);
    }

    res.json({
      ok: true,
      dealId,
      chat: result.chat,
      existing: result.existing
    });
  } catch (err) {
    console.error("POST /api/posts/:id/accept-offer error:", err);
    fail(res, 500, "Failed to accept offer.");
  }
});

module.exports = router;
