// test_phase6.js
// Automated verification for Phase 6: UI polish and production hardening

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database
const TEST_DB = path.join(__dirname, "test_phase6.db");
const TEST_JSON = path.join(__dirname, "test_phase6_data.json");
const TEST_UPLOADS = path.join(__dirname, "public", "uploads");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;

const app = require("./server");

// Helper: in-memory mock HTTP request that handles cookies, headers, and binary bodies
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
    let chunks = [];
    res.write = chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const fullBuf = Buffer.concat(chunks);
      const str = fullBuf.toString("utf8");
      let json = null;
      try { json = JSON.parse(str); } catch (e) {}
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        data: json !== null ? json : str,
        raw: fullBuf
      });
    };

    if (body) {
      let b;
      if (Buffer.isBuffer(body)) {
        b = body;
        if (!headers["content-type"]) {
          req.headers["content-type"] = "application/octet-stream";
        }
      } else if (typeof body === "string") {
        b = Buffer.from(body);
      } else {
        b = Buffer.from(JSON.stringify(body));
      }
      req.headers["content-length"] = b.length;
      req.push(b);
    }
    req.push(null);

    app.handle(req, res);
  });
}

async function runTests() {
  console.log("=== Starting Phase 6 Test Suite ===");

  try {
    // 1. Security Headers Verification
    console.log("\n1. Testing Security Headers...");
    const rootRes = await mockRequest(app, { method: "GET", url: "/" });
    assert.strictEqual(rootRes.status, 200);
    assert.strictEqual(rootRes.headers["x-frame-options"], "DENY", "X-Frame-Options must be DENY");
    assert.strictEqual(rootRes.headers["x-content-type-options"], "nosniff", "X-Content-Type-Options must be nosniff");
    assert.ok(rootRes.headers["strict-transport-security"], "HSTS must be set");
    assert.ok(rootRes.headers["content-security-policy"], "CSP must be set");
    assert.ok(
      rootRes.headers["content-security-policy"].includes("default-src 'self'"),
      "CSP must include default-src 'self'"
    );
    console.log("✓ Security headers present: X-Frame-Options, nosniff, HSTS, and CSP");

    // 2. Authentication setup for subsequent tests
    console.log("\n2. Setting up test account...");
    const authRes = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
    assert.strictEqual(authRes.status, 200);
    const cookieHeader = authRes.headers["set-cookie"];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(";")[0] : cookieHeader.split(";")[0];
    assert.ok(cookie, "Session cookie returned");
    const testUsername = "p6user_" + Math.random().toString(36).substring(2, 6);
    await mockRequest(app, {
      method: "POST",
      url: "/api/auth/username",
      cookie,
      body: { username: testUsername }
    });
    console.log(`✓ Authenticated as u/${testUsername}`);

    // 3. CSRF Protection Check
    console.log("\n3. Testing CSRF Protection...");
    // A cross-site request with an external Origin header should be rejected with 403
    const csrfRes = await mockRequest(app, {
      method: "POST",
      url: "/api/communities",
      cookie,
      headers: {
        origin: "https://malicious-attacker-site.com"
      },
      body: { name: "csrf_test_comm", desc: "test" }
    });
    assert.strictEqual(csrfRes.status, 403, "Cross-origin mutating request must be rejected with 403 Forbidden");
    assert.ok(
      csrfRes.data.error.includes("CSRF"),
      "Error should indicate CSRF protection failure"
    );
    console.log("✓ Cross-origin mutating request successfully blocked with 403 Forbidden");

    // Valid origin matching Host should pass
    const validCommRes = await mockRequest(app, {
      method: "POST",
      url: "/api/communities",
      cookie,
      headers: {
        origin: "http://localhost"
      },
      body: { name: "p6_community", desc: "Phase 6 community", city: "Delhi" }
    });
    assert.strictEqual(validCommRes.status, 200, "Valid origin request must succeed");
    console.log("✓ Same-origin request succeeded");

    // 4. Image Upload & Magic-byte Validation
    console.log("\n4. Testing Image Upload & Magic-Byte Validation...");
    
    // 4a. Reject non-image / spoofed file
    const fakeImageBuffer = Buffer.from("THIS_IS_A_TEXT_FILE_NOT_AN_IMAGE", "utf8");
    const badUploadRes = await mockRequest(app, {
      method: "POST",
      url: "/api/upload",
      cookie,
      headers: {
        "content-type": "image/jpeg"
      },
      body: fakeImageBuffer
    });
    assert.strictEqual(badUploadRes.status, 400, "Fake image must be rejected with 400");
    assert.ok(
      badUploadRes.data.error.includes("Unsupported image format"),
      "Error message should indicate invalid format"
    );
    console.log("✓ Magic-byte validation rejected spoofed text file masquerading as JPEG");

    // 4b. Reject oversized file (> 2MB)
    const oversizedBuffer = Buffer.alloc(2.5 * 1024 * 1024, 0);
    oversizedBuffer[0] = 0xff;
    oversizedBuffer[1] = 0xd8;
    oversizedBuffer[2] = 0xff;
    const oversizedRes = await mockRequest(app, {
      method: "POST",
      url: "/api/upload",
      cookie,
      headers: {
        "content-type": "image/jpeg"
      },
      body: oversizedBuffer
    });
    assert.strictEqual(oversizedRes.status, 400, "Oversized image must be rejected with 400");
    console.log("✓ Strict 2MB file size limit enforced");

    // 4c. Valid JPEG image (magic bytes: FF D8 FF E0 ...)
    const validJpegBuffer = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.alloc(64, 0xaa)
    ]);
    const goodUploadRes = await mockRequest(app, {
      method: "POST",
      url: "/api/upload",
      cookie,
      headers: {
        "content-type": "image/jpeg"
      },
      body: validJpegBuffer
    });
    assert.strictEqual(goodUploadRes.status, 200, "Valid JPEG upload must succeed");
    assert.ok(goodUploadRes.data.url, "Upload must return image URL");
    assert.ok(goodUploadRes.data.url.startsWith("/uploads/"), "URL must be in /uploads/");
    console.log(`✓ Valid JPEG uploaded successfully: ${goodUploadRes.data.url}`);

    // Verify file exists on disk
    const filename = path.basename(goodUploadRes.data.url);
    const diskPath = path.join(TEST_UPLOADS, filename);
    assert.ok(fs.existsSync(diskPath), "Saved image file must exist on disk");
    console.log("✓ File verified on persistent disk");

    // 5. Post creation with imageUrl & retrieval
    console.log("\n5. Testing Post Creation with Image URL...");
    const createPostRes = await mockRequest(app, {
      method: "POST",
      url: "/api/communities/p6_community/posts",
      cookie,
      body: {
        title: "Lost Golden Retriever in Sector 18",
        body: "Attached photo of our lost dog. Please message if found!",
        postType: "NEED",
        budget: "₹2000 reward",
        targetTime: "Yesterday 4 PM",
        location: "Sector 18 Market",
        city: "Delhi",
        imageUrl: goodUploadRes.data.url
      }
    });
    assert.strictEqual(createPostRes.status, 200);
    assert.strictEqual(createPostRes.data.imageUrl, goodUploadRes.data.url, "Returned post must have imageUrl");
    console.log(`✓ Post created with image ID: ${createPostRes.data.id}`);

    // Retrieve via GET /api/posts/:id
    const getPostRes = await mockRequest(app, {
      method: "GET",
      url: `/api/posts/${createPostRes.data.id}`
    });
    assert.strictEqual(getPostRes.status, 200);
    assert.strictEqual(getPostRes.data.imageUrl, goodUploadRes.data.url, "GET /api/posts/:id must return imageUrl");
    console.log("✓ Verified imageUrl persisted in database and returned in post details");

    console.log("\n=== ALL PHASE 6 TESTS PASSED ===");
  } finally {
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (e) {}
    }
    if (fs.existsSync(TEST_JSON)) {
      try { fs.unlinkSync(TEST_JSON); } catch (e) {}
    }
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
