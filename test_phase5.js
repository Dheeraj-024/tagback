const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database
const TEST_DB = path.join(__dirname, "test_phase5.db");
const TEST_JSON = path.join(__dirname, "test_phase5_data.json");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;
process.env.POST_COOLDOWN_MS = "0";

const { db, queries } = require("./db");
const { eventBus } = require("./lib/events");
const app = require("./server");

// Helper: in-memory mock HTTP request that handles cookies and streaming
function mockRequest(app, { method = "GET", url = "/", headers = {}, body = null, cookie = null }) {
  return new Promise((resolve) => {
    const socket = new Duplex({
      read() {},
      write(chunk, enc, cb) { cb(); }
    });
    socket.encrypted = false;
    socket.remoteAddress = "127.0.0.1";

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    const reqHeaders = Object.assign(
      { "content-type": "application/json", host: "localhost" },
      headers
    );
    if (cookie) reqHeaders.cookie = cookie;
    req.headers = reqHeaders;

    const res = new http.ServerResponse(req);
    let output = "";
    res.write = chunk => { output += chunk; return true; };
    res.end = chunk => {
      if (chunk) output += chunk;
      let json = null;
      try { json = JSON.parse(output); } catch (e) {}
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        data: json !== null ? json : output
      });
    };

    if (body) {
      const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      req.headers["content-length"] = b.length;
      req.push(b);
    }
    req.push(null);

    app.handle(req, res);
  });
}

// Helper: open an SSE stream connection and collect emitted events
function openSSEStream(app, { url, cookie = null }) {
  const socket = new Duplex({ read() {}, write(chunk, enc, cb) { cb(); } });
  socket.encrypted = false;
  socket.remoteAddress = "127.0.0.1";

  const req = new http.IncomingMessage(socket);
  req.method = "GET";
  req.url = url;
  const reqHeaders = { host: "localhost", accept: "text/event-stream" };
  if (cookie) reqHeaders.cookie = cookie;
  req.headers = reqHeaders;

  const res = new http.ServerResponse(req);
  const events = [];
  let buffer = "";

  res.write = chunk => {
    buffer += chunk.toString();
    const parts = buffer.split("\n\n");
    while (parts.length > 1) {
      const raw = parts.shift();
      if (!raw.trim() || raw.startsWith(":")) continue;
      const lines = raw.split("\n");
      let eventType = "message";
      let eventData = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) eventData = line.slice(6).trim();
      }
      let parsed = eventData;
      try { parsed = JSON.parse(eventData); } catch (e) {}
      events.push({ event: eventType, data: parsed });
    }
    buffer = parts[0];
    return true;
  };

  req.push(null);
  app.handle(req, res);

  return {
    events,
    close: () => {
      req.emit("close");
      res.end();
    }
  };
}

function extractCookie(resOrHeaders) {
  const headers = (resOrHeaders && resOrHeaders.headers) ? resOrHeaders.headers : resOrHeaders;
  const sc = headers["set-cookie"];
  if (!sc) return null;
  const cookieStr = Array.isArray(sc) ? sc[0] : sc;
  return cookieStr.split(";")[0].trim();
}

async function runTests() {
  console.log("=== Phase 5: Notifications & Realtime Tests ===");

  // 1. Setup users: Alice (author), Bob (helper), Charlie (moderator)
  const regAlice = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const cookieAlice = extractCookie(regAlice);
  const userAlice = regAlice.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "alice_author" },
    cookie: cookieAlice
  });

  const regBob = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const cookieBob = extractCookie(regBob);
  const userBob = regBob.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "bob_helper" },
    cookie: cookieBob
  });

  const regCharlie = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const cookieCharlie = extractCookie(regCharlie);
  const userCharlie = regCharlie.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "charlie_mod" },
    cookie: cookieCharlie
  });

  console.log("✓ Created users: alice_author, bob_helper, charlie_mod");

  // Create test community and post
  await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    body: { name: "city_helpers", desc: "Local assistance" },
    cookie: cookieAlice
  });
  // Appoint Charlie as mod
  await mockRequest(app, {
    method: "POST",
    url: "/api/communities/city_helpers/moderators",
    body: { username: "charlie_mod" },
    cookie: cookieAlice
  });

  const postRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/city_helpers/posts",
    body: { title: "Need help moving furniture tomorrow", body: "Heavy sofa and table", postType: "NEED" },
    cookie: cookieAlice
  });
  assert.strictEqual(postRes.status, 200);
  const postId = postRes.data.id;

  // 2. Testing Pluggable Push/Email Hooks Interface
  let pushHookCalls = [];
  eventBus.registerPushProvider({
    sendPush: async ({ userId, title, body, data }) => {
      pushHookCalls.push({ userId, title, body, data });
    }
  });

  // 3. Testing Reply Notifications & SSE Stream
  console.log("\n--- Testing Reply Notifications & SSE Stream ---");
  // Alice opens notification SSE stream
  const aliceNotifStream = openSSEStream(app, { url: "/api/notifications/stream", cookie: cookieAlice });

  // Initial event should be unread_count
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(aliceNotifStream.events.length, 1);
  assert.strictEqual(aliceNotifStream.events[0].event, "unread_count");
  assert.strictEqual(aliceNotifStream.events[0].data.count, 0);

  // Bob comments on Alice's post
  const comment1Res = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/comments`,
    body: { text: "I have a small truck and can help you tomorrow for ₹600." },
    cookie: cookieBob
  });
  assert.strictEqual(comment1Res.status, 200);
  const comment1Id = comment1Res.data.comment.id;

  // Alice should receive notification over SSE stream in real-time
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(aliceNotifStream.events.length >= 2, true);
  const notifEvent = aliceNotifStream.events.find(e => e.event === "notification");
  assert.ok(notifEvent, "Alice should receive a notification event via SSE");
  assert.strictEqual(notifEvent.data.notification.type, "reply");
  assert.strictEqual(notifEvent.data.unreadCount, 1);

  // Push hook should have been called
  assert.strictEqual(pushHookCalls.length >= 1, true);
  assert.strictEqual(pushHookCalls[0].userId, userAlice.id);

  // Check unread count endpoint
  const unreadRes = await mockRequest(app, {
    method: "GET",
    url: "/api/notifications/unread-count",
    cookie: cookieAlice
  });
  assert.strictEqual(unreadRes.status, 200);
  assert.strictEqual(unreadRes.data.count, 1);

  // Check notifications list endpoint
  const listRes = await mockRequest(app, {
    method: "GET",
    url: "/api/notifications",
    cookie: cookieAlice
  });
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(listRes.data.notifications.length, 1);
  const notif1 = listRes.data.notifications[0];
  assert.strictEqual(notif1.read, false);

  // Alice marks notification as read
  const markReadRes = await mockRequest(app, {
    method: "POST",
    url: `/api/notifications/${notif1.id}/read`,
    cookie: cookieAlice
  });
  assert.strictEqual(markReadRes.status, 200);
  assert.strictEqual(markReadRes.data.unreadCount, 0);

  console.log("✓ Reply notifications, push hook, and mark-as-read verified");

  // 4. Testing Nested Reply Notification: Alice replies to Bob's comment -> Bob receives notification
  const bobNotifStream = openSSEStream(app, { url: "/api/notifications/stream", cookie: cookieBob });
  await new Promise(r => setTimeout(r, 20));

  await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/comments`,
    body: { text: "That sounds great Bob, when can you start?", parentId: comment1Id },
    cookie: cookieAlice
  });

  await new Promise(r => setTimeout(r, 50));
  const bobNotifEvent = bobNotifStream.events.find(e => e.event === "notification");
  assert.ok(bobNotifEvent, "Bob should receive reply notification via SSE");
  assert.strictEqual(bobNotifEvent.data.notification.type, "reply");
  assert.ok(bobNotifEvent.data.notification.title.includes("alice_author"));

  console.log("✓ Nested comment reply notification delivered to parent comment author");

  // 5. Testing Real-time Post Comment Stream (`GET /api/posts/:id/stream`)
  // Acceptance criterion: a reply appears on another user's screen within about 2 seconds without refreshing
  console.log("\n--- Testing Post Comments Realtime SSE Stream ---");
  const postCommentStream = openSSEStream(app, { url: `/api/posts/${postId}/stream` });
  await new Promise(r => setTimeout(r, 20));

  const tStart = Date.now();
  await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/comments`,
    body: { text: "Live test comment from Charlie" },
    cookie: cookieCharlie
  });

  // Verify comment appeared in post stream within 200ms
  await new Promise(r => setTimeout(r, 50));
  const elapsed = Date.now() - tStart;
  const commentStreamEvent = postCommentStream.events.find(e => e.event === "comment");
  assert.ok(commentStreamEvent, "Comment should appear in post SSE stream without page reload");
  assert.strictEqual(commentStreamEvent.data.text, "Live test comment from Charlie");
  assert.strictEqual(commentStreamEvent.data.nick, "charlie_mod");
  assert.ok(elapsed < 2000, `Reply delivery took ${elapsed}ms (well under 2s acceptance limit)`);
  console.log(`✓ Live comment streamed via SSE in ${elapsed}ms (< 2s acceptance requirement)`);

  // 6. Testing Offer Accepted Notification & Deal Chat SSE Stream
  console.log("\n--- Testing Offer Accepted & Private Deal Chat Stream ---");
  // Alice accepts Bob's offer
  const acceptRes = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/accept-offer`,
    body: { commentId: comment1Id },
    cookie: cookieAlice
  });
  assert.strictEqual(acceptRes.status, 200);
  const dealId = acceptRes.data.dealId;

  // Bob should receive accepted_offer notification
  await new Promise(r => setTimeout(r, 50));
  const acceptedNotif = bobNotifStream.events.find(e => e.data && e.data.notification && e.data.notification.type === "accepted_offer");
  assert.ok(acceptedNotif, "Bob should receive accepted_offer notification via SSE");
  assert.ok(acceptedNotif.data.notification.title.includes("accepted"));

  // Both connect to deal chat SSE stream
  const aliceDealStream = openSSEStream(app, { url: `/api/deals/${dealId}/stream`, cookie: cookieAlice });
  const bobDealStream = openSSEStream(app, { url: `/api/deals/${dealId}/stream`, cookie: cookieBob });
  await new Promise(r => setTimeout(r, 20));

  // Alice sends message in deal chat
  await mockRequest(app, {
    method: "POST",
    url: `/api/deals/${dealId}/messages`,
    body: { text: "Hi Bob, can you come at 11 AM?" },
    cookie: cookieAlice
  });

  await new Promise(r => setTimeout(r, 50));
  // Bob should receive message event in deal stream
  const bobDealMsg = bobDealStream.events.find(e => e.event === "message");
  assert.ok(bobDealMsg, "Bob should receive real-time deal message in stream");
  assert.strictEqual(bobDealMsg.data.body, "Hi Bob, can you come at 11 AM?");

  // Bob should also receive deal_message notification
  const bobMsgNotif = bobNotifStream.events.find(e => e.data && e.data.notification && e.data.notification.type === "deal_message");
  assert.ok(bobMsgNotif, "Bob should receive deal_message notification");

  // 7. Testing Deal Fulfilled Status Event & Notification
  await mockRequest(app, {
    method: "POST",
    url: `/api/deals/${dealId}/fulfill`,
    body: { rating: 5, review: "Fantastic helper!" },
    cookie: cookieAlice
  });

  await new Promise(r => setTimeout(r, 50));
  // Bob receives status event in deal stream
  const bobDealStatus = bobDealStream.events.find(e => e.event === "status");
  assert.ok(bobDealStatus, "Bob should receive deal fulfilled status event in stream");
  assert.strictEqual(bobDealStatus.data.status, "fulfilled");
  assert.strictEqual(bobDealStatus.data.rating, 5);

  // Bob receives deal_fulfilled notification
  const bobFulfillNotif = bobNotifStream.events.find(e => e.data && e.data.notification && e.data.notification.type === "deal_fulfilled");
  assert.ok(bobFulfillNotif, "Bob should receive deal_fulfilled notification");

  console.log("✓ Offer acceptance, deal chat real-time streaming, and deal fulfillment verified");

  // 8. Testing Moderation Notifications: Report & Ban
  console.log("\n--- Testing Moderation Notifications ---");
  const charlieNotifStream = openSSEStream(app, { url: "/api/notifications/stream", cookie: cookieCharlie });
  await new Promise(r => setTimeout(r, 20));

  // Bob reports a post -> Charlie (moderator) receives notification
  await mockRequest(app, {
    method: "POST",
    url: "/api/reports",
    body: { targetType: "post", targetId: postId, reason: "Spam content" },
    cookie: cookieBob
  });

  await new Promise(r => setTimeout(r, 50));
  const modNotif = charlieNotifStream.events.find(e => e.data && e.data.notification && e.data.notification.type === "mod_action");
  assert.ok(modNotif, "Charlie (moderator) should receive notification of new report");

  // Charlie bans Bob -> Bob receives mod_action notification
  await mockRequest(app, {
    method: "POST",
    url: "/api/communities/city_helpers/mod/ban",
    body: { userId: userBob.id, reason: "Breaking community guidelines" },
    cookie: cookieCharlie
  });

  await new Promise(r => setTimeout(r, 50));
  const banNotif = bobNotifStream.events.find(e => e.data && e.data.notification && e.data.notification.title.includes("banned"));
  assert.ok(banNotif, "Banned user should receive mod_action notification");

  // 9. Mark All Notifications Read
  const markAllRes = await mockRequest(app, {
    method: "POST",
    url: "/api/notifications/read-all",
    cookie: cookieBob
  });
  assert.strictEqual(markAllRes.status, 200);
  assert.strictEqual(markAllRes.data.unreadCount, 0);

  const bobUnreadFinal = await mockRequest(app, {
    method: "GET",
    url: "/api/notifications/unread-count",
    cookie: cookieBob
  });
  assert.strictEqual(bobUnreadFinal.data.count, 0);

  // Clean up streams
  aliceNotifStream.close();
  bobNotifStream.close();
  charlieNotifStream.close();
  postCommentStream.close();
  aliceDealStream.close();
  bobDealStream.close();

  console.log("✓ Moderation notifications and mark-all-read verified");
  console.log("\n=== ALL PHASE 5 TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});

