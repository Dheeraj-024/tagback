const assert = require("assert");
const http = require("http");
const { Duplex } = require("stream");
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

async function runAITests() {
  console.log("=== Phase 7: AI Integration Tests ===");

  console.log("\n1. Testing Smart Post Parsing (POST /api/ai/parse-post)...");
  const parseRes = await mockRequest(app, {
    method: "POST",
    url: "/api/ai/parse-post",
    body: { text: "need cab from Connaught Place to Airport tomorrow 6am around Rs 800" }
  });
  assert.strictEqual(parseRes.status, 200);
  assert(parseRes.data.ok);
  assert.strictEqual(parseRes.data.data.category, "RIDE_SHARING");
  assert.strictEqual(parseRes.data.data.budget, "₹800");
  assert(parseRes.data.data.location.includes("Connaught Place"));
  console.log(`✓ Smart Post Parser extracted category: ${parseRes.data.data.category}, budget: ${parseRes.data.data.budget}, loc: ${parseRes.data.data.location}`);

  console.log("\n2. Testing Finder QR Assistant (POST /api/ai/finder-assist)...");
  const assistRes = await mockRequest(app, {
    method: "POST",
    url: "/api/ai/finder-assist",
    body: {
      itemName: "MacBook Air M4",
      draft: "found on 2nd floor library near window",
      ownerName: "Dheeraj"
    }
  });
  assert.strictEqual(assistRes.status, 200);
  assert(assistRes.data.ok);
  assert(assistRes.data.message.includes("Dheeraj"));
  assert(assistRes.data.message.includes("MacBook Air M4"));
  console.log(`✓ Finder Assistant drafted message: "${assistRes.data.message}"`);

  console.log("\n3. Testing Deal Chat Reply Suggestions (POST /api/ai/suggest-replies)...");
  const suggRes = await mockRequest(app, {
    method: "POST",
    url: "/api/ai/suggest-replies",
    body: {
      title: "Need cab from CP to Airport",
      postType: "NEED"
    }
  });
  assert.strictEqual(suggRes.status, 200);
  assert(suggRes.data.ok);
  assert(Array.isArray(suggRes.data.suggestions));
  assert(suggRes.data.suggestions.length >= 2);
  console.log(`✓ Generated ${suggRes.data.suggestions.length} smart reply suggestions:`, suggRes.data.suggestions);

  console.log("\n4. Testing Automated Content Moderation (POST /api/ai/moderate)...");
  const cleanMod = await mockRequest(app, {
    method: "POST",
    url: "/api/ai/moderate",
    body: {
      title: "Offering ride to Noida Sector 62",
      body: "3 seats available in Swift, leaving at 9am."
    }
  });
  assert.strictEqual(cleanMod.status, 200);
  assert.strictEqual(cleanMod.data.moderation.safe, true);
  console.log("✓ Clean post passed moderation with safe=true");

  const scamMod = await mockRequest(app, {
    method: "POST",
    url: "/api/ai/moderate",
    body: {
      title: "Earn quick money",
      body: "Send advance payment to Google Pay before booking confirmation"
    }
  });
  assert.strictEqual(scamMod.status, 200);
  assert.strictEqual(scamMod.data.moderation.safe, false);
  assert.strictEqual(scamMod.data.moderation.flagAction, "block");
  console.log("✓ Advance-fee scam detected and blocked by moderation");

  console.log("\n5. Testing Enforcement on Post Creation (POST /api/communities/:name/posts)...");
  // Register user session
  const regUser = await mockRequest(app, {
    method: "POST",
    url: "/api/auth/register",
    body: {}
  });
  const cookie = extractCookie(regUser.headers);

  // Attempt to publish an advance payment scam post
  const blockedPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/cabs_city/posts",
    body: {
      title: "Cheap cab deal",
      body: "Send advance payment via UPI to confirm your ride now"
    },
    cookie
  });
  assert.strictEqual(blockedPost.status, 400);
  assert(blockedPost.data.error.includes("Safety alert"));
  console.log(`✓ Safety system rejected scam post with 400: "${blockedPost.data.error}"`);

  console.log("\n6. Testing Thread Summarizer (GET /api/ai/summary/:postId)...");
  // Publish valid post
  const goodPost = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/cabs_city/posts",
    body: {
      title: "Best route from Gurgaon to Airport at peak hours?",
      body: "Need suggestions for travel tomorrow morning."
    },
    cookie
  });
  assert.strictEqual(goodPost.status, 200);

  // Add a reply
  await mockRequest(app, {
    method: "POST",
    url: `/api/posts/${goodPost.data.id}/comments`,
    body: { text: "Take the Dwarka Expressway, it is much faster now during 8-10am." },
    cookie
  });

  const sumRes = await mockRequest(app, {
    method: "GET",
    url: `/api/ai/summary/${goodPost.data.id}`
  });
  assert.strictEqual(sumRes.status, 200);
  assert(sumRes.data.ok);
  assert(sumRes.data.summary);
  console.log(`✓ AI Thread Summary: "${sumRes.data.summary}"`);

  console.log("\n=== ALL PHASE 7 AI TESTS PASSED SUCCESSFULLY! ===");
  process.exit(0);
}

runAITests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

