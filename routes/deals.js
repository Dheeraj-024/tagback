const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { requireUser } = require("../middleware/auth");
const { eventBus } = require("../lib/events");
const { clip, fail } = require("../lib/utils");

// GET /api/deals - List deals for current user
router.get("/", requireUser, (req, res) => {
  try {
    const deals = queries.getUserDeals(req.user.id);
    res.json(deals);
  } catch (err) {
    console.error("GET /api/deals error:", err);
    fail(res, 500, "Unable to load deals.");
  }
});

// GET /api/deals/:id - View single deal chat thread & messages (participants only)
router.get("/:id", requireUser, (req, res) => {
  try {
    const chat = queries.getDealChat(req.params.id, req.user.id);
    if (!chat) return fail(res, 404, "Deal chat not found.");
    if (chat.error === "forbidden") return fail(res, 403, "You do not have permission to view this deal.");
    res.json(chat);
  } catch (err) {
    console.error("GET /api/deals/:id error:", err);
    fail(res, 500, "Unable to load deal chat.");
  }
});

// GET /api/deals/:id/stream - SSE endpoint for live deal chat messages (participants only)
router.get("/:id/stream", requireUser, (req, res) => {
  const chat = queries.getDealChat(req.params.id, req.user.id);
  if (!chat) return fail(res, 404, "Deal chat not found.");
  if (chat.error === "forbidden") return fail(res, 403, "Forbidden.");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders && res.flushHeaders();

  const onMessage = (msg) => {
    try {
      res.write(eventBus.formatSSE("message", msg));
    } catch (e) {}
  };

  const onStatus = (statusData) => {
    try {
      res.write(eventBus.formatSSE("status", statusData));
    } catch (e) {}
  };

  const msgChannel = `deal:${req.params.id}:message`;
  const statusChannel = `deal:${req.params.id}:status`;
  eventBus.on(msgChannel, onMessage);
  eventBus.on(statusChannel, onStatus);

  const pingInterval = setInterval(() => {
    eventBus.sendKeepAlive(res);
  }, 20000);

  req.on("close", () => {
    clearInterval(pingInterval);
    eventBus.removeListener(msgChannel, onMessage);
    eventBus.removeListener(statusChannel, onStatus);
  });
});

// POST /api/deals/:id/messages - Send a message in private deal chat
router.post("/:id/messages", requireUser, (req, res) => {
  const body = clip(req.body.text || req.body.body, 1000);
  if (!body) {
    return fail(res, 400, "Message text is required.");
  }

  try {
    const chat = queries.getDealChat(req.params.id, req.user.id);
    if (!chat) return fail(res, 404, "Deal chat not found.");
    if (chat.error === "forbidden") return fail(res, 403, "You are not a participant in this deal.");

    const result = queries.sendDealMessage({
      chatId: req.params.id,
      senderId: req.user.id,
      body
    });

    if (result.error === "notFound") return fail(res, 404, "Deal chat not found.");
    if (result.error === "forbidden") return fail(res, 403, "You are not a participant in this deal.");
    if (result.error === "closed") return fail(res, 400, result.message || "This deal is closed.");

    // Live SSE broadcast to deal chat stream
    eventBus.emitDealMessage(req.params.id, result.message);

    // In-app notification to the other party
    const recipientId = (chat.authorId === req.user.id) ? chat.helperId : chat.authorId;
    const notif = queries.createNotification({
      userId: recipientId,
      type: "deal_message",
      title: `New message from u/${req.user.username}`,
      body: clip(body, 120),
      link: `/deals/${req.params.id}`
    });
    eventBus.emitNotification(recipientId, notif);

    res.json(result);
  } catch (err) {
    console.error("POST /api/deals/:id/messages error:", err);
    fail(res, 500, "Failed to send message.");
  }
});

// POST /api/deals/:id/fulfill - Mark deal fulfilled and submit rating
router.post("/:id/fulfill", requireUser, (req, res) => {
  const rating = parseInt(req.body.rating, 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    return fail(res, 400, "Rating must be an integer between 1 and 5.");
  }
  const review = clip(req.body.review, 500);

  try {
    const chat = queries.getDealChat(req.params.id, req.user.id);
    if (!chat) return fail(res, 404, "Deal chat not found.");
    if (chat.error === "forbidden") return fail(res, 403, "You do not have permission to access this deal.");

    const result = queries.fulfillDealChat({
      chatId: req.params.id,
      authorId: req.user.id,
      rating,
      review
    });

    if (result.error === "notFound") return fail(res, 404, "Deal chat not found.");
    if (result.error === "forbidden") return fail(res, 403, result.message || "Only the author can mark deal fulfilled.");
    if (result.error === "alreadyFulfilled") return fail(res, 400, result.message || "Already fulfilled.");

    // Broadcast deal status change via SSE
    eventBus.emitDealStatus(req.params.id, {
      status: "fulfilled",
      rating,
      review
    });

    // Notify helper that deal was fulfilled & rated
    const notif = queries.createNotification({
      userId: chat.helperId,
      type: "deal_fulfilled",
      title: "Deal marked fulfilled!",
      body: `u/${req.user.username} marked your deal on "${clip(chat.post ? chat.post.title : "post", 50)}" as fulfilled and gave you ★${rating}/5 stars.`,
      link: `/deals/${req.params.id}`
    });
    eventBus.emitNotification(chat.helperId, notif);

    res.json(result);
  } catch (err) {
    console.error("POST /api/deals/:id/fulfill error:", err);
    fail(res, 500, "Failed to complete deal.");
  }
});

// GET /api/deals/users/:id/trust - Get user trust badge & rating
router.get("/users/:id/trust", (req, res) => {
  try {
    const trust = queries.getUserTrustBadge(req.params.id);
    if (!trust) return fail(res, 404, "User not found.");
    res.json(trust);
  } catch (err) {
    console.error("GET /api/deals/users/:id/trust error:", err);
    fail(res, 500, "Unable to load user trust badge.");
  }
});

module.exports = router;

