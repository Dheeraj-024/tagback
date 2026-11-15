const express = require("express");
const router = express.Router();
const { queries } = require("../db");
const { requireUser } = require("../middleware/auth");
const { eventBus } = require("../lib/events");
const { fail } = require("../lib/utils");

// GET /api/notifications - List user's notifications
router.get("/", requireUser, (req, res) => {
  try {
    const unreadOnly = req.query.unread === "true" || req.query.unread === "1";
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
    const notifications = queries.getNotifications(req.user.id, { limit, unreadOnly });
    const unreadCount = queries.getUnreadNotificationCount(req.user.id);
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error("GET /api/notifications error:", err);
    fail(res, 500, "Unable to load notifications.");
  }
});

// GET /api/notifications/unread-count - Get unread count
router.get("/unread-count", requireUser, (req, res) => {
  try {
    const count = queries.getUnreadNotificationCount(req.user.id);
    res.json({ count });
  } catch (err) {
    console.error("GET /api/notifications/unread-count error:", err);
    fail(res, 500, "Unable to load unread count.");
  }
});

// POST /api/notifications/:id/read - Mark single notification as read
router.post("/:id/read", requireUser, (req, res) => {
  try {
    const result = queries.markNotificationRead(req.params.id, req.user.id);
    const count = queries.getUnreadNotificationCount(req.user.id);
    res.json({ ok: true, changed: result.changed, unreadCount: count });
  } catch (err) {
    console.error("POST /api/notifications/:id/read error:", err);
    fail(res, 500, "Failed to update notification.");
  }
});

// POST /api/notifications/read-all - Mark all notifications as read
router.post("/read-all", requireUser, (req, res) => {
  try {
    const result = queries.markAllNotificationsRead(req.user.id);
    res.json({ ok: true, changed: result.changed, unreadCount: 0 });
  } catch (err) {
    console.error("POST /api/notifications/read-all error:", err);
    fail(res, 500, "Failed to update notifications.");
  }
});

// GET /api/notifications/stream - Server-Sent Events stream for real-time notifications
router.get("/stream", requireUser, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders && res.flushHeaders();

  // Send initial unread count
  const initialCount = queries.getUnreadNotificationCount(req.user.id);
  res.write(eventBus.formatSSE("unread_count", { count: initialCount }));

  // Handler for user's notifications
  const onNotification = (notification) => {
    try {
      const count = queries.getUnreadNotificationCount(req.user.id);
      res.write(eventBus.formatSSE("notification", { notification, unreadCount: count }));
    } catch (e) {}
  };

  const channel = `user:${req.user.id}:notification`;
  eventBus.on(channel, onNotification);

  // Keep-alive ping every 20 seconds
  const pingInterval = setInterval(() => {
    eventBus.sendKeepAlive(res);
  }, 20000);

  req.on("close", () => {
    clearInterval(pingInterval);
    eventBus.removeListener(channel, onNotification);
  });
});

module.exports = router;

