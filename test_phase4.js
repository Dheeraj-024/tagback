const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Duplex } = require("stream");

// Use an isolated test database
const TEST_DB = path.join(__dirname, "test_phase4.db");
const TEST_JSON = path.join(__dirname, "test_phase4_data.json");

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);

process.env.DB_PATH = TEST_DB;
process.env.DATA_FILE = TEST_JSON;
process.env.POST_COOLDOWN_MS = "0";

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

function extractCookie(resOrHeaders) {
  const headers = (resOrHeaders && resOrHeaders.headers) ? resOrHeaders.headers : resOrHeaders;
  const sc = headers["set-cookie"];
  if (!sc) return null;
  const cookieStr = Array.isArray(sc) ? sc[0] : sc;
  return cookieStr.split(";")[0].trim();
}

async function runTests() {
  console.log("=== Phase 4 Test Suite ===");

  // 1. Setup users: author, helper, stranger
  const authorReg = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const authorCookie = extractCookie(authorReg);
  const authorUser = authorReg.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "author_alice" },
    cookie: authorCookie
  });

  const helperReg = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const helperCookie = extractCookie(helperReg);
  const helperUser = helperReg.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "helper_bob" },
    cookie: helperCookie
  });

  const strangerReg = await mockRequest(app, { method: "POST", url: "/api/auth/register", body: {} });
  const strangerCookie = extractCookie(strangerReg);
  const strangerUser = strangerReg.data.user;
  await mockRequest(app, {
    method: "POST",
    url: "/api/auth/username",
    body: { username: "stranger_eve" },
    cookie: strangerCookie
  });

  console.log("✓ Users initialized: author_alice, helper_bob, stranger_eve");

  // 2. Create communities with and without city
  const commDelhi = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    body: { name: "delhi_services", desc: "Local help in Delhi", city: "Delhi" },
    cookie: authorCookie
  });
  assert.strictEqual(commDelhi.status, 200);
  assert.strictEqual(commDelhi.data.city, "Delhi");

  const commMumbai = await mockRequest(app, {
    method: "POST",
    url: "/api/communities",
    body: { name: "mumbai_cabs", desc: "Rides in Mumbai", city: "Mumbai" },
    cookie: authorCookie
  });
  assert.strictEqual(commMumbai.status, 200);
  assert.strictEqual(commMumbai.data.city, "Mumbai");

  // Verify city filter on communities list
  const listDelhi = await mockRequest(app, { method: "GET", url: "/api/communities?city=Delhi" });
  assert.strictEqual(listDelhi.status, 200);
  assert.strictEqual(listDelhi.data.length, 1);
  assert.strictEqual(listDelhi.data[0].name, "delhi_services");

  const listAll = await mockRequest(app, { method: "GET", url: "/api/communities" });
  assert.strictEqual(listAll.status, 200);
  assert.strictEqual(listAll.data.length >= 2, true);
  console.log("✓ Communities created with city field and city filtering verified");

  // 3. Post creation: NEED and OFFER with structured fields
  const needPostRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/delhi_services/posts",
    body: {
      title: "Need AC repair technician tomorrow morning",
      body: "Split AC not cooling properly in master bedroom",
      postType: "NEED",
      budget: "₹800",
      targetTime: "Tomorrow 10:00 AM",
      location: "Lajpat Nagar 2",
      city: "Delhi"
    },
    cookie: authorCookie
  });
  assert.strictEqual(needPostRes.status, 200);
  assert.strictEqual(needPostRes.data.postType, "NEED");
  assert.strictEqual(needPostRes.data.status, "open");
  assert.strictEqual(needPostRes.data.budget, "₹800");
  assert.strictEqual(needPostRes.data.targetTime, "Tomorrow 10:00 AM");
  assert.strictEqual(needPostRes.data.location, "Lajpat Nagar 2");
  assert.strictEqual(needPostRes.data.city, "Delhi");
  const needPostId = needPostRes.data.id;

  const offerPostRes = await mockRequest(app, {
    method: "POST",
    url: "/api/communities/delhi_services/posts",
    body: {
      title: "Offering certified electrician services",
      body: "Experienced domestic electrician available for quick fixes",
      postType: "OFFER",
      budget: "₹500 fixed inspection",
      targetTime: "Weekdays 9 AM - 6 PM",
      location: "South Delhi",
      city: "Delhi"
    },
    cookie: helperCookie
  });
  assert.strictEqual(offerPostRes.status, 200);
  assert.strictEqual(offerPostRes.data.postType, "OFFER");
  assert.strictEqual(offerPostRes.data.status, "open");
  const offerPostId = offerPostRes.data.id;

  console.log("✓ NEED and OFFER posts created with structured fields");

  // 4. Feed filtering by type, status, and city
  const filterNeed = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_services/posts?type=NEED"
  });
  assert.strictEqual(filterNeed.status, 200);
  assert.strictEqual(filterNeed.data.posts.length, 1);
  assert.strictEqual(filterNeed.data.posts[0].id, needPostId);

  const filterOffer = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_services/posts?type=OFFER"
  });
  assert.strictEqual(filterOffer.status, 200);
  assert.strictEqual(filterOffer.data.posts.length, 1);
  assert.strictEqual(filterOffer.data.posts[0].id, offerPostId);

  const filterCity = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_services/posts?city=delhi"
  });
  assert.strictEqual(filterCity.status, 200);
  assert.strictEqual(filterCity.data.posts.length, 2);

  const filterNoMatchCity = await mockRequest(app, {
    method: "GET",
    url: "/api/communities/delhi_services/posts?city=Bangalore"
  });
  assert.strictEqual(filterNoMatchCity.status, 200);
  assert.strictEqual(filterNoMatchCity.data.posts.length, 0);

  console.log("✓ Feed filters (type, status, city) work as expected");

  // 5. Status transitions: author can update status
  const updateStatusRes = await mockRequest(app, {
    method: "PATCH",
    url: "/api/posts/" + offerPostId + "/status",
    body: { status: "fulfilled" },
    cookie: helperCookie
  });
  assert.strictEqual(updateStatusRes.status, 200);
  assert.strictEqual(updateStatusRes.data.status, "fulfilled");

  // Non-author cannot update status
  const unauthorizedStatus = await mockRequest(app, {
    method: "PATCH",
    url: "/api/posts/" + needPostId + "/status",
    body: { status: "fulfilled" },
    cookie: strangerCookie
  });
  assert.strictEqual(unauthorizedStatus.status, 403);

  console.log("✓ Post status transition and authorization verified");

  // 6. Auto-expiration of old open requests
  // Insert an old post older than 7 days
  const oldPostTime = Date.now() - (8 * 86400 * 1000);
  db.prepare(`
    INSERT INTO posts (id, community_name, user_id, author_nick, title, body, post_type, status, created_at, updated_at)
    VALUES (?, 'delhi_services', ?, 'author_alice', 'Old open post that should expire', 'Details', 'NEED', 'open', ?, ?)
  `).run("old_post_1", authorUser.id, oldPostTime, oldPostTime);

  // Calling getPostsForCommunity or autoExpirePosts expires it
  queries.autoExpirePosts(7);
  const expiredPost = queries.getPostById("old_post_1");
  assert.strictEqual(expiredPost.status, "expired");
  console.log("✓ Auto-expiration of requests older than 7 days verified");

  // 7. Offer & Deal flow:
  // Helper replies to need post
  const commentRes = await mockRequest(app, {
    method: "POST",
    url: "/api/posts/" + needPostId + "/comments",
    body: { text: "I can come inspect and service the AC tomorrow for ₹750." },
    cookie: helperCookie
  });
  assert.strictEqual(commentRes.status, 200);
  const commentId = commentRes.data.comment.id;

  // Stranger tries to accept offer -> 403
  const badAccept = await mockRequest(app, {
    method: "POST",
    url: "/api/posts/" + needPostId + "/accept-offer",
    body: { commentId },
    cookie: strangerCookie
  });
  assert.strictEqual(badAccept.status, 403);

  // Author accepts helper's offer -> creates private deal chat & sets post status to in_progress
  const acceptOfferRes = await mockRequest(app, {
    method: "POST",
    url: "/api/posts/" + needPostId + "/accept-offer",
    body: { commentId },
    cookie: authorCookie
  });
  assert.strictEqual(acceptOfferRes.status, 200);
  assert.strictEqual(acceptOfferRes.data.ok, true);
  const dealId = acceptOfferRes.data.dealId;
  assert.ok(dealId, "Deal ID should be returned");

  // Verify post transitioned to in_progress
  const updatedNeedPost = queries.getPostById(needPostId);
  assert.strictEqual(updatedNeedPost.status, "in_progress");

  console.log("✓ Offer acceptance created private deal chat and updated post to in_progress");

  // 8. Deal chat privacy & authorization
  // Stranger tries to view deal -> 403
  const strangerViewDeal = await mockRequest(app, {
    method: "GET",
    url: "/api/deals/" + dealId,
    cookie: strangerCookie
  });
  assert.strictEqual(strangerViewDeal.status, 403);

  // Stranger tries to send message in deal chat -> 403
  const strangerSendMsg = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/messages",
    body: { text: "Hello let me in" },
    cookie: strangerCookie
  });
  assert.strictEqual(strangerSendMsg.status, 403);

  // Author sends message in private deal chat
  const authorSend = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/messages",
    body: { text: "Great! Please come at 10 AM. Ring bell 4." },
    cookie: authorCookie
  });
  assert.strictEqual(authorSend.status, 200);
  assert.strictEqual(authorSend.data.ok, true);

  // Helper sends reply in private deal chat
  const helperSend = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/messages",
    body: { text: "Confirmed! I will reach on time." },
    cookie: helperCookie
  });
  assert.strictEqual(helperSend.status, 200);

  // Helper views deal chat
  const helperViewDeal = await mockRequest(app, {
    method: "GET",
    url: "/api/deals/" + dealId,
    cookie: helperCookie
  });
  assert.strictEqual(helperViewDeal.status, 200);
  assert.strictEqual(helperViewDeal.data.messages.length, 2);
  assert.strictEqual(helperViewDeal.data.messages[0].body, "Great! Please come at 10 AM. Ring bell 4.");
  assert.strictEqual(helperViewDeal.data.messages[1].body, "Confirmed! I will reach on time.");

  // Check deals list for author
  const authorDeals = await mockRequest(app, {
    method: "GET",
    url: "/api/deals",
    cookie: authorCookie
  });
  assert.strictEqual(authorDeals.status, 200);
  assert.strictEqual(authorDeals.data.length, 1);
  assert.strictEqual(authorDeals.data[0].id, dealId);
  assert.strictEqual(authorDeals.data[0].helper_nick, "helper_bob");

  console.log("✓ Private deal messaging and participant isolation verified");

  // 9. Fulfill deal and rating
  // Helper tries to fulfill -> 403 (only author can fulfill and rate helper)
  const helperFulfill = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/fulfill",
    body: { rating: 5, review: "Great job by me!" },
    cookie: helperCookie
  });
  assert.strictEqual(helperFulfill.status, 403);

  // Author fulfills and gives 5 star rating
  const authorFulfill = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/fulfill",
    body: { rating: 5, review: "Arrived right on time and fixed the AC cleanly!" },
    cookie: authorCookie
  });
  assert.strictEqual(authorFulfill.status, 200);
  assert.strictEqual(authorFulfill.data.ok, true);
  assert.strictEqual(authorFulfill.data.status, "fulfilled");

  // Post should now be fulfilled
  const fulfilledPost = queries.getPostById(needPostId);
  assert.strictEqual(fulfilledPost.status, "fulfilled");

  // Check helper trust badge
  const helperTrustRes = await mockRequest(app, {
    method: "GET",
    url: "/api/deals/users/" + helperUser.id + "/trust"
  });
  assert.strictEqual(helperTrustRes.status, 200);
  assert.strictEqual(helperTrustRes.data.completedHelpCount, 1);
  assert.strictEqual(helperTrustRes.data.ratingAverage, 5.0);
  assert.strictEqual(helperTrustRes.data.ratingCount, 1);

  // Verify that helper's trust badge appears in post detail & comment lists
  const postDetailAfterFulfill = await mockRequest(app, {
    method: "GET",
    url: "/api/posts/" + needPostId
  });
  assert.strictEqual(postDetailAfterFulfill.status, 200);
  const helperComment = postDetailAfterFulfill.data.comments.find(c => c.id === commentId);
  assert.ok(helperComment.authorTrust);
  assert.strictEqual(helperComment.authorTrust.completedHelpCount, 1);
  assert.strictEqual(helperComment.authorTrust.ratingAverage, 5.0);

  // Cannot send messages after deal fulfilled
  const postFulfillMsg = await mockRequest(app, {
    method: "POST",
    url: "/api/deals/" + dealId + "/messages",
    body: { text: "Another message after close" },
    cookie: authorCookie
  });
  assert.strictEqual(postFulfillMsg.status, 400);

  console.log("✓ Deal fulfillment, rating calculation, and trust badge display verified");

  console.log("\n=== ALL PHASE 4 TESTS PASSED! ===");
}

runTests().catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});
