const { EventEmitter } = require("events");

class AppEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);

    // Optional provider hooks interface (pluggable email/push hooks)
    this.emailProvider = null;
    this.pushProvider = null;
  }

  // Register an optional email provider: { sendEmail: async ({ to, subject, body, html }) => {} }
  registerEmailProvider(provider) {
    this.emailProvider = provider;
  }

  // Register an optional push provider: { sendPush: async ({ userId, title, body, data }) => {} }
  registerPushProvider(provider) {
    this.pushProvider = provider;
  }

  // Format Server-Sent Event data
  formatSSE(event, data) {
    const payload = typeof data === "object" ? JSON.stringify(data) : String(data);
    return `event: ${event}\ndata: ${payload}\n\n`;
  }

  // Send a keepalive comment to an SSE response stream
  sendKeepAlive(res) {
    try {
      res.write(": keepalive\n\n");
    } catch (e) {}
  }

  // Broadcast user notification
  emitNotification(userId, notification) {
    this.emit(`user:${userId}:notification`, notification);

    // Call optional push/email hooks if configured
    if (this.pushProvider && typeof this.pushProvider.sendPush === "function") {
      Promise.resolve(
        this.pushProvider.sendPush({
          userId,
          title: notification.title,
          body: notification.body,
          data: { link: notification.link, type: notification.type }
        })
      ).catch(err => console.error("Push provider error:", err));
    }
  }

  // Broadcast comment to post viewers
  emitPostComment(postId, comment) {
    this.emit(`post:${postId}:comment`, comment);
  }

  // Broadcast message to deal chat participants
  emitDealMessage(chatId, message) {
    this.emit(`deal:${chatId}:message`, message);
  }

  // Broadcast deal status update (e.g. fulfilled)
  emitDealStatus(chatId, statusData) {
    this.emit(`deal:${chatId}:status`, statusData);
  }
}

const eventBus = new AppEventBus();

module.exports = { eventBus };

