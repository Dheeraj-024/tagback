const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database and json file
const TEST_DB = path.join(__dirname, "test_tagback.db");
const TEST_JSON = path.join(__dirname, "test_data.json");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

// Seed a test JSON file to verify one-time migration from JSON
const sampleJson = {
  communities: [
    { name: "test_city", desc: "Test community", by: "Tester", t: 1000 }
  ],
  posts: [
    {
      id: "tp1",
      comm: "test_city",
      title: "Need a test ride",
      body: "Just testing",
      nick: "TestUser",
      t: 1001,
      comments: [
        { id: "tc1", nick: "TestDriver", text: "I can test drive", t: 1002 }
      ]
    }
  ]
};
fs.writeFileSync(TEST_JSON, JSON.stringify(sampleJson));

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;

const { db, queries } = require("./db");

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
    res.write = chunk => {
      output += chunk;
      return true;
    };
    res.end = chunk => {
      if (chunk) output += chunk;
      let json = null;
      try { json = JSON.parse(output); } catch (e) {}
      resolve({ status: res.statusCode, headers: res.getHeaders(), data: json || output });
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

async function runTests() {
  console.log("--- 1. Testing Database Schema Tables ---");
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all().map(t => t.name);

  const requiredTables = [
    "users",
    "communities",
    "memberships",
    "posts",
    "comments",
    "votes",
    "reports",
    "notifications",
    "_migrations"
  ];

  for (const rt of requiredTables) {
    assert(tables.includes(rt), `Missing table: ${rt}`);
    console.log(`✓ Table exists: ${rt}`);
  }

  console.log("\n--- 2. Testing Migration from data.json ---");
  const comms = queries.getCommunities();
  const testComm = comms.find(c => c.name === "test_city");
  assert(testComm, "test_city should have been migrated from JSON");
  assert.strictEqual(testComm.desc, "Test community");
  assert.strictEqual(testComm.by, "Tester");
  assert.strictEqual(testComm.posts, 1);
  console.log("✓ Community migrated correctly");

  const post = queries.getPostById("tp1");
  assert(post, "Post tp1 should exist");
  assert.strictEqual(post.title, "Need a test ride");
  assert.strictEqual(post.author_nick, "TestUser");
  assert.strictEqual(post.comment_count, 1);
  console.log("✓ Post migrated correctly");

  const comments = queries.getCommentsForPost("tp1");
  assert.strictEqual(comments.length, 1);
  assert.strictEqual(comments[0].body, "I can test drive");
  assert.strictEqual(comments[0].author_nick, "TestDriver");
  console.log("✓ Comments migrated correctly");

  console.log("\n--- 3. Testing Express Endpoints & Pagination ---");
  const app = require("./server");

  // GET /api/communities
  const resComms = await mockRequest(app, { method: "GET", url: "/api/communities" });
  assert.strictEqual(resComms.status, 200);
  assert(Array.isArray(resComms.data));
  console.log("✓ GET /api/communities returned array");

  // Create an authenticated session for write tests
  const regRes = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  assert.strictEqual(regRes.status, 200);
  const sc = regRes.headers["set-cookie"];
  const cookieStr = (Array.isArray(sc) ? sc[0] : sc).split(";")[0].trim();

  // POST /api/communities
  const resNewComm = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    cookie: cookieStr,
    body: { name: "delhi_cabs", desc: "Delhi cabs network" }
  });
  assert.strictEqual(resNewComm.status, 200);
  assert.strictEqual(resNewComm.data.name, "delhi_cabs");
  console.log("✓ POST /api/communities created delhi_cabs");

  // Create multiple posts to verify pagination and no 500-cap
  for (let i = 1; i <= 5; i++) {
    const resPost = await mockRequest(app, {
      method: "POST",
      url: "/api/communities/delhi_cabs/posts",
      cookie: cookieStr,
      body: { title: `Ride need #${i}`, body: `Details for trip ${i}` }
    });
    assert.strictEqual(resPost.status, 200);
  }
  console.log("✓ Created 5 posts in delhi_cabs");

  // GET /api/communities/delhi_cabs/posts with pagination ?limit=2&page=1
  const resPage1 = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_cabs/posts?limit=2&page=1"
  });
  assert.strictEqual(resPage1.status, 200);
  assert.strictEqual(resPage1.data.posts.length, 2);
  assert.strictEqual(resPage1.data.pagination.total, 5);
  assert.strictEqual(resPage1.data.pagination.totalPages, 3);
  assert.strictEqual(resPage1.data.pagination.hasMore, true);
  console.log("✓ Pagination page 1 limit 2 works");

  // GET /api/communities/delhi_cabs/posts page 3
  const resPage3 = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_cabs/posts?limit=2&page=3"
  });
  assert.strictEqual(resPage3.status, 200);
  assert.strictEqual(resPage3.data.posts.length, 1);
  assert.strictEqual(resPage3.data.pagination.hasMore, false);
  console.log("✓ Pagination page 3 works");

  // GET /api/posts/:id and POST /api/posts/:id/comments
  const firstPostId = resPage1.data.posts[0].id;
  const resComment = await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${firstPostId}/comments`,
    cookie: cookieStr,
    body: { text: "I can drive you for 500" }
  });
  assert.strictEqual(resComment.status, 200);
  console.log("✓ POST /api/posts/:id/comments added comment");

  const resPostDetail = await mockRequest(app, {
    method: "GET",
    url: `/api/posts/${firstPostId}`
  });
  assert.strictEqual(resPostDetail.status, 200);
  assert.strictEqual(resPostDetail.data.id, firstPostId);
  assert.strictEqual(resPostDetail.data.comments.length, 1);
  assert.strictEqual(resPostDetail.data.comments[0].text, "I can drive you for 500");
  assert.strictEqual(resPostDetail.data.comments[0].nick, regRes.data.user.username);
  console.log("✓ GET /api/posts/:id returns post with comments");

  // Verify backward compatibility for legacy non-community routes (e.g. /api/place/station)
  const resPlace = await mockRequest(app, {
    method: "GET",
    url: "/api/place/station"
  });
  assert.strictEqual(resPlace.status, 200);
  assert.strictEqual(resPlace.data.id, "station");
  console.log("✓ GET /api/place/station legacy route works");

  console.log("\n--- 4. Testing Persistence Across Server Restart ---");
  // Close database connection, then reopen
  db.close();

  const Database = require("better-sqlite3");
  const reopenedDb = new Database(TEST_DB);
  const checkPost = reopenedDb.prepare("SELECT * FROM posts WHERE id = ?").get(firstPostId);
  assert(checkPost, "Post must survive restart in SQLite database");
  assert.strictEqual(checkPost.comment_count, 1);

  const checkComment = reopenedDb.prepare("SELECT * FROM comments WHERE post_id = ?").get(firstPostId);
  assert(checkComment, "Comment must survive restart in SQLite database");
  assert.strictEqual(checkComment.body, "I can drive you for 500");
  reopenedDb.close();
  console.log("✓ Data persists across simulated restart");

  // Clean up test files
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

  console.log("\nALL PHASE 0 TESTS PASSED SUCCESSFULLY! 🎉");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
