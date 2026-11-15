const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database
const TEST_DB = path.join(__dirname, "test_phase1.db");
const TEST_JSON = path.join(__dirname, "test_phase1_data.json");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;

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

// Helper: extract cookie string from Set-Cookie header
function extractCookie(headers) {
  const sc = headers["set-cookie"];
  if (!sc) return null;
  const cookieStr = Array.isArray(sc) ? sc[0] : sc;
  return cookieStr.split(";")[0].trim();
}

async function runTests() {
  console.log("=== Phase 1: Accounts and Identity Tests ===");

  console.log("\n--- 1. Testing Anonymous Device Registration ---");
  const reg1 = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  assert.strictEqual(reg1.status, 200);
  assert(reg1.data.user, "Should return user object");
  assert(reg1.data.user.username.startsWith("user_"), "Anonymous username should start with user_");
  assert.strictEqual(reg1.data.user.usernameChosen, false, "usernameChosen should be false initially");
  assert(reg1.data.recovery, "Should return recovery key");
  const cookie1 = extractCookie(reg1.headers);
  assert(cookie1 && cookie1.startsWith("tb_session="), "Should set tb_session cookie");
  console.log(`✓ Anonymous registration created: ${reg1.data.user.username}`);

  console.log("\n--- 2. Testing Reserved Names ---");
  // Reserved usernames
  const reservedNames = ["admin", "official", "pingme", "support", "moderator"];
  for (const name of reservedNames) {
    const res = await mockRequest(app, {
      method: "POST",
      url: "/api/auth/register",
      body: { username: name }
    });
    assert.strictEqual(res.status, 400, `Registration with reserved name '${name}' should return 400`);
    assert(res.data.error.includes("reserved"), `Error should mention reserved: ${res.data.error}`);
  }
  console.log("✓ Reserved usernames blocked on registration");

  // Reserved community names
  for (const name of ["admin", "official", "pingme", "support"]) {
    const res = await mockRequest(app, {
      method: "POST",
      url: "/api/communities",
      body: { name, desc: "Reserved test" },
      cookie: cookie1
    });
    assert.strictEqual(res.status, 400, `Community creation with reserved name '${name}' should return 400`);
    assert(res.data.error.includes("reserved"), `Error should mention reserved: ${res.data.error}`);
  }
  console.log("✓ Reserved community names blocked");

  console.log("\n--- 3. Testing Username Chosen Once ---");
  // Pick permanent username
  const setNameRes = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "aarav_dev" },
    cookie: cookie1
  });
  assert.strictEqual(setNameRes.status, 200);
  assert.strictEqual(setNameRes.data.user.username, "aarav_dev");
  assert.strictEqual(setNameRes.data.user.usernameChosen, true);
  console.log("✓ Set permanent username to aarav_dev");

  // Attempting to change username a second time must fail with 409
  const changeAgain = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "aarav_super" },
    cookie: cookie1
  });
  assert.strictEqual(changeAgain.status, 409, "Should reject second username change");
  console.log("✓ Second username change blocked (chosen once)");

  // Attempting to claim an already taken username must fail
  const reg2 = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const cookie2 = extractCookie(reg2.headers);
  const dupName = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "aarav_dev" },
    cookie: cookie2
  });
  assert.strictEqual(dupName.status, 409, "Duplicate username should return 409");
  console.log("✓ Duplicate username blocked");

  console.log("\n--- 4. Testing Account Recovery & Sessions ---");
  // Check /api/auth/me with cookie1
  const meRes = await mockRequest(app, { method: "GET", url: "/api/auth/me", cookie: cookie1 });
  assert.strictEqual(meRes.status, 200);
  assert.strictEqual(meRes.data.user.username, "aarav_dev");

  // Check /api/auth/me without cookie
  const meUnauth = await mockRequest(app, { method: "GET", url: "/api/auth/me" });
  assert.strictEqual(meUnauth.status, 401);
  console.log("✓ GET /api/auth/me verifies session cookie");

  // Login with recovery key
  const loginRes = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/login",
    body: { recovery: reg1.data.recovery }
  });
  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.data.user.username, "aarav_dev");
  const newCookie = extractCookie(loginRes.headers);
  assert(newCookie, "Login should set new session cookie");
  console.log("✓ Login via recovery key works");

  // Invalid recovery key
  const badLogin = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/login",
    body: { recovery: "wrong_key_123" }
  });
  assert.strictEqual(badLogin.status, 401);
  console.log("✓ Invalid recovery key rejected");

  console.log("\n--- 5. Testing Anti-Spoofing on Writes ---");
  // Create community: unauthenticated must fail
  const unauthComm = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    body: { name: "delhi_drivers", desc: "Drivers in Delhi" }
  });
  assert.strictEqual(unauthComm.status, 401, "Unauthenticated community creation should return 401");

  // Authenticated community creation: spoofed nick is IGNORED
  const authComm = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    body: { name: "delhi_drivers", desc: "Drivers in Delhi", nick: "SpoofedAdmin" },
    cookie: cookie1
  });
  assert.strictEqual(authComm.status, 200);
  const commInfo = queries.getCommunity("delhi_drivers");
  assert.strictEqual(commInfo.by, "aarav_dev", "Author must be session user, not spoofed nick");
  console.log("✓ Community author taken from session (spoofed nick ignored)");

  // Create post: unauthenticated must fail
  const unauthPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/delhi_drivers/posts",
    body: { title: "Ride to airport", body: "Need cab" }
  });
  assert.strictEqual(unauthPost.status, 401, "Unauthenticated post should return 401");

  // Authenticated post creation: spoofed nick is IGNORED
  const authPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/delhi_drivers/posts",
    body: { title: "Ride to airport", body: "Need cab", nick: "FakeCelebrity" },
    cookie: cookie1
  });
  assert.strictEqual(authPost.status, 200);
  const postId = authPost.data.id;
  const postData = queries.getPostById(postId);
  assert.strictEqual(postData.author_nick, "aarav_dev", "Post author must be session username");
  assert.strictEqual(postData.user_id, reg1.data.user.id, "Post user_id must be session user ID");
  console.log("✓ Post author taken from session (spoofed nick ignored)");

  // Create comment: unauthenticated must fail
  const unauthComment = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/comments`,
    body: { text: "Unauthenticated reply" }
  });
  assert.strictEqual(unauthComment.status, 401, "Unauthenticated comment should return 401");

  // Authenticated comment: spoofed nick is IGNORED
  const authComment = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${postId}/comments`,
    body: { text: "I can drive you", nick: "FakeDriver" },
    cookie: cookie1
  });
  assert.strictEqual(authComment.status, 200);
  const comments = queries.getCommentsForPost(postId);
  assert.strictEqual(comments.length, 1);
  assert.strictEqual(comments[0].author_nick, "aarav_dev", "Comment author must be session username");
  assert.strictEqual(comments[0].user_id, reg1.data.user.id, "Comment user_id must be session user ID");
  console.log("✓ Comment author taken from session (spoofed nick ignored)");

  console.log("\n--- 6. Testing Rate Limits Stored in SQLite ---");
  // Check that rate_limits table contains entries
  const rateLimitCount = db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get();
  assert(rateLimitCount.n > 0, "Rate limit hits must be recorded in SQLite rate_limits table");
  console.log(`✓ SQLite rate_limits table has ${rateLimitCount.n} persisted hit records`);

  // Verify rate limit persists across simulated restart
  db.close();
  const Database = require("better-sqlite3");
  const reopenedDb = new Database(TEST_DB);
  const checkLimits = reopenedDb.prepare("SELECT COUNT(*) AS n FROM rate_limits").get();
  assert.strictEqual(checkLimits.n, rateLimitCount.n, "Rate limits must survive restart in SQLite");
  reopenedDb.close();
  console.log("✓ Rate limits survive database restart");

  // Clean up test files
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

  console.log("\nALL PHASE 1 TESTS PASSED SUCCESSFULLY! 🎉");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Phase 1 test failed:", err);
  process.exit(1);
});
