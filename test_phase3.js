const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database
const TEST_DB = path.join(__dirname, "test_phase3.db");
const TEST_JSON = path.join(__dirname, "test_phase3_data.json");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;

// Custom thresholds for testing
process.env.MIN_ACCOUNT_AGE_FOR_LINKS = "1000"; // 1 second for test
process.env.MIN_ACCOUNT_AGE_FOR_COMMUNITY = "1000"; // 1 second for test
process.env.POST_COOLDOWN_MS = "500"; // 500 ms for test

const { db, queries } = require("./db");
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

function extractCookie(headers) {
  const sc = headers["set-cookie"];
  if (!sc) return null;
  const cookieStr = Array.isArray(sc) ? sc[0] : sc;
  return cookieStr.split(";")[0].trim();
}

async function createUser(app, { ageMs = 10000 } = {}) {
  const res = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const cookie = extractCookie(res.headers);
  const user = res.data.user;

  // If ageMs is specified, backdate the created_at in the database
  if (ageMs > 0) {
    db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(Date.now() - ageMs, user.id);
    user.createdAt = Date.now() - ageMs;
  }

  return { user, cookie };
}

async function runTests() {
  console.log("=== Phase 3: Moderation and Safety Tests ===");

  // 1. Create users with different account ages
  const owner = await createUser(app, { ageMs: 100000 }); // Mature account
  const modUser = await createUser(app, { ageMs: 100000 });
  const regularUser = await createUser(app, { ageMs: 100000 });
  const brandNewUser = await createUser(app, { ageMs: 0 }); // Age 0 ms (newborn account)

  console.log(`Created test users: Owner (${owner.user.username}), Mod (${modUser.user.username}), Regular (${regularUser.user.username}), New (${brandNewUser.user.username})`);

  console.log("\n--- 1. Testing Spam Control: Minimum Account Age to Create Community ---");
  // Brand new account attempts to create a community -> 403 Forbidden
  const newAccComm = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    cookie: brandNewUser.cookie,
    body: { name: "spam_comm", desc: "Spammy" }
  });
  assert.strictEqual(newAccComm.status, 403);
  assert(newAccComm.data.error.includes("too new"), "Should reject community creation from new account");

  // Mature account creates community -> 200 OK
  const matureComm = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    cookie: owner.cookie,
    body: { name: "safety_hub", desc: "Community for safety discussions" }
  });
  assert.strictEqual(matureComm.status, 200);
  console.log("✓ Minimum account age for community creation enforced");

  console.log("\n--- 2. Testing Roles: Owner, Moderator, Member & Appointing/Removing ---");
  // Owner updates community rules
  const ruleRes = await mockRequest(app, {
    method: "PUT",
    url: "/api/communities/safety_hub/rules",
    cookie: owner.cookie,
    body: { rules: "1. Be polite.\n2. No advertising.\n3. Keep phone numbers in private deal chats." }
  });
  assert.strictEqual(ruleRes.status, 200);
  assert.strictEqual(ruleRes.data.rules, "1. Be polite.\n2. No advertising.\n3. Keep phone numbers in private deal chats.");

  // Regular user tries to update rules -> 403 Forbidden
  const regRuleRes = await mockRequest(app, {
    method: "PUT",
    url: "/api/communities/safety_hub/rules",
    cookie: regularUser.cookie,
    body: { rules: "Hacked rules" }
  });
  assert.strictEqual(regRuleRes.status, 403);

  // Check rules returned in public community endpoint
  const commInfo = await mockRequest(app, { method: "GET", url: "/api/communities/safety_hub/posts" });
  assert.strictEqual(commInfo.status, 200);
  assert(commInfo.data.community.rules.includes("Be polite"));

  // Regular user tries to access mod reports queue -> 403 Forbidden
  const regModQueue = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/safety_hub/mod/reports",
    cookie: regularUser.cookie
  });
  assert.strictEqual(regModQueue.status, 403);

  // Owner appoints modUser as moderator
  const appointRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/moderators",
    cookie: owner.cookie,
    body: { username: modUser.user.username }
  });
  assert.strictEqual(appointRes.status, 200);
  assert.strictEqual(appointRes.data.role, "moderator");

  // Appointed moderator can now view mod queue
  const modQueueRes = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/safety_hub/mod/reports",
    cookie: modUser.cookie
  });
  assert.strictEqual(modQueueRes.status, 200);
  assert(Array.isArray(modQueueRes.data));

  // Owner removes moderator
  const removeModRes = await mockRequest(app, {
    method: "DELETE",
    url: `/api/communities/safety_hub/moderators/${modUser.user.username}`,
    cookie: owner.cookie
  });
  assert.strictEqual(removeModRes.status, 200);
  assert.strictEqual(removeModRes.data.role, "member");

  // Previously appointed moderator now gets 403 again
  const modQueueAfter = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/safety_hub/mod/reports",
    cookie: modUser.cookie
  });
  assert.strictEqual(modQueueAfter.status, 403);

  // Re-appoint moderator for remaining tests
  await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/moderators",
    cookie: owner.cookie,
    body: { username: modUser.user.username }
  });
  console.log("✓ Community roles and appointment/removal verified");

  console.log("\n--- 3. Testing Spam Controls: Links & Phone Numbers from New Accounts ---");
  // Brand new account posts link -> 403 Forbidden
  const linkPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: brandNewUser.cookie,
    body: { title: "Check my website https://spamsite.xyz", body: "Great offers" }
  });
  assert.strictEqual(linkPost.status, 403);
  assert(linkPost.data.error.includes("external links"));

  // Brand new account posts phone number -> 403 Forbidden
  const phonePost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: brandNewUser.cookie,
    body: { title: "Call me for deals", body: "Call +91 9876543210 immediately" }
  });
  assert.strictEqual(phonePost.status, 403);
  assert(phonePost.data.error.includes("phone numbers"));

  // Mature account posts normal request -> 200 OK
  const maturePost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: regularUser.cookie,
    body: { title: "Need a taxi to airport", body: "Leaving at 7 AM, 2 bags" }
  });
  assert.strictEqual(maturePost.status, 200);
  const postId = maturePost.data.id;
  console.log("✓ External links and phone numbers blocked for new accounts");

  console.log("\n--- 4. Testing Spam Controls: Cooldown & Duplicate Post Detection ---");
  // Immediate second post from regularUser -> 429 Cooldown
  const fastPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: regularUser.cookie,
    body: { title: "Another ride need", body: "Leaving at 8 AM" }
  });
  assert.strictEqual(fastPost.status, 429);
  assert(fastPost.data.error.includes("second"), "Error should mention cooldown");

  // Wait for cooldown to elapse
  await new Promise(r => setTimeout(r, 600));

  // User posts exact duplicate title/body -> 400 Duplicate detected
  const dupPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: regularUser.cookie,
    body: { title: "Need a taxi to airport", body: "Leaving at 7 AM, 2 bags" }
  });
  assert.strictEqual(dupPost.status, 400);
  assert(dupPost.data.error.includes("Duplicate"), "Error should mention duplicate post");
  console.log("✓ Post cooldown and duplicate post detection working properly");

  console.log("\n--- 5. Testing Emergency Keyword Rules (Deterministic & Call 112) ---");
  await new Promise(r => setTimeout(r, 600)); // wait out cooldown
  const emgPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: regularUser.cookie,
    body: { title: "Terrible accident on highway, someone is bleeding", body: "Please send an ambulance help now" }
  });
  assert.strictEqual(emgPost.status, 200);
  assert.strictEqual(emgPost.data.emergency, true, "Should flag emergency");
  assert.strictEqual(emgPost.data.call112, true, "Should indicate Call 112 prompt");
  assert(emgPost.data.message.includes("112"), "Should advise calling 112");
  console.log("✓ Emergency keyword rules detect crisis and return Call 112 directive");

  console.log("\n--- 6. Testing Reporting, Mod Queue, Content Removal & Audit Logs ---");
  // Regular user reports emergency post as inappropriate test
  const reportRes = await mockRequest(app, {
    method: "POST",
    url: "/api/reports",
    cookie: regularUser.cookie,
    body: { targetType: "post", targetId: postId, reason: "Inappropriate contact information" }
  });
  assert.strictEqual(reportRes.status, 200);
  assert(reportRes.data.report.id, "Should return report id");
  const reportId = reportRes.data.report.id;

  // Moderator checks queue
  const modQueue = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/safety_hub/mod/reports",
    cookie: modUser.cookie
  });
  assert.strictEqual(modQueue.status, 200);
  assert.strictEqual(modQueue.data.length, 1);
  assert.strictEqual(modQueue.data[0].id, reportId);
  assert.strictEqual(modQueue.data[0].target.id, postId);

  // Moderator removes content via report
  const removeRes = await mockRequest(app, {
    method: "POST",
    url: `/api/communities/safety_hub/mod/reports/${reportId}/remove`,
    cookie: modUser.cookie
  });
  assert.strictEqual(removeRes.status, 200);
  assert.strictEqual(removeRes.data.status, "removed");

  // Post should now be soft-deleted
  const checkPost = await mockRequest(app, { method: "GET", url: `/api/posts/${postId}` });
  assert.strictEqual(checkPost.data.title, "[deleted]");
  assert.strictEqual(checkPost.data.body, "[deleted]");
  assert.strictEqual(!!checkPost.data.deleted, true);

  // Check audit log recorded this removal
  const auditLogs = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/safety_hub/mod/logs",
    cookie: modUser.cookie
  });
  assert.strictEqual(auditLogs.status, 200);
  assert(auditLogs.data.some(l => l.action === "remove_content"), "Audit logs must record remove_content");
  console.log("✓ Content reporting, mod queue processing, removal and audit logging verified");

  console.log("\n--- 7. Testing User Ban: Banned User Cannot Post, Comment or Vote ---");
  // Moderator bans regularUser from community
  const banRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/mod/ban",
    cookie: modUser.cookie,
    body: { userId: regularUser.user.id, reason: "Repeated spam violations" }
  });
  assert.strictEqual(banRes.status, 200);
  assert.strictEqual(banRes.data.banned, true);

  // Banned user attempts to post -> 403 Forbidden
  const bannedPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/posts",
    cookie: regularUser.cookie,
    body: { title: "I am trying to post again", body: "Please let me" }
  });
  assert.strictEqual(bannedPost.status, 403);
  assert(bannedPost.data.error.includes("banned"), "Error should state user is banned");

  // Banned user attempts to comment on another post -> 403 Forbidden
  const emgPostId = emgPost.data.id;
  const bannedComment = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${emgPostId}/comments`,
    cookie: regularUser.cookie,
    body: { text: "Comment from banned user" }
  });
  assert.strictEqual(bannedComment.status, 403);
  assert(bannedComment.data.error.includes("banned"), "Error should state user is banned");

  // Banned user attempts to vote -> 403 Forbidden
  const bannedVote = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${emgPostId}/vote`,
    cookie: regularUser.cookie,
    body: { direction: 1 }
  });
  assert.strictEqual(bannedVote.status, 403);
  assert(bannedVote.data.error.includes("banned"), "Error should state user is banned");

  // Moderator unbans user
  const unbanRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/safety_hub/mod/unban",
    cookie: modUser.cookie,
    body: { userId: regularUser.user.id }
  });
  assert.strictEqual(unbanRes.status, 200);
  assert.strictEqual(unbanRes.data.unbanned, true);

  // Unbanned user can now vote
  const allowedVote = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${emgPostId}/vote`,
    cookie: regularUser.cookie,
    body: { direction: 1 }
  });
  assert.strictEqual(allowedVote.status, 200);
  console.log("✓ User ban and unban enforce participation blocks across posts, comments, and votes");

  console.log("\n=== ALL PHASE 3 TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

