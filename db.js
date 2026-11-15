const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || process.env.SQLITE_DB_PATH || path.join(__dirname, "tagback.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Initialize Schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      token_hash TEXT,
      recovery_hash TEXT,
      role TEXT DEFAULT 'user',
      karma INTEGER DEFAULT 0,
      banned INTEGER DEFAULT 0,
      username_chosen INTEGER DEFAULT 0,
      completed_help_count INTEGER DEFAULT 0,
      rating_sum INTEGER DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS communities (
      name TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      city TEXT,
      rules TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      community_name TEXT NOT NULL REFERENCES communities(name) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_name, user_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      community_name TEXT NOT NULL REFERENCES communities(name) ON DELETE CASCADE,
      user_id TEXT,
      author_nick TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      post_type TEXT DEFAULT 'POST',
      status TEXT DEFAULT 'open',
      budget REAL,
      target_time TEXT,
      location TEXT,
      city TEXT,
      image_url TEXT,
      score INTEGER DEFAULT 0,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT,
      author_nick TEXT NOT NULL,
      body TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      depth INTEGER DEFAULT 0,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS votes (
      user_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
      target_id TEXT NOT NULL,
      direction INTEGER NOT NULL CHECK(direction IN (-1, 0, 1)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
      target_id TEXT NOT NULL,
      community_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'dismissed', 'removed')),
      resolved_by TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      link TEXT,
      read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mod_logs (
      id TEXT PRIMARY KEY,
      community_name TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_bans (
      community_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      banned_by TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_name, user_id)
    );

    CREATE TABLE IF NOT EXISTS deal_chats (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      helper_id TEXT NOT NULL REFERENCES users(id),
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'fulfilled', 'cancelled')),
      rating INTEGER,
      review TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS deal_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES deal_chats(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_comm_created ON posts(community_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_comm_score ON posts(community_name, score DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_comm ON memberships(community_name);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id, target_type);
    CREATE INDEX IF NOT EXISTS idx_reports_comm_status ON reports(community_name, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON rate_limits(key, ts);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_mod_logs_comm ON mod_logs(community_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_community_bans_user ON community_bans(user_id);
    CREATE INDEX IF NOT EXISTS idx_deal_chats_post ON deal_chats(post_id);
    CREATE INDEX IF NOT EXISTS idx_deal_chats_author ON deal_chats(author_id);
    CREATE INDEX IF NOT EXISTS idx_deal_chats_helper ON deal_chats(helper_id);
    CREATE INDEX IF NOT EXISTS idx_deal_messages_chat ON deal_messages(chat_id, created_at ASC);
  `);

  // Safe table alterations for existing databases
  try { db.exec("ALTER TABLE users ADD COLUMN completed_help_count INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN rating_sum INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN rating_count INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE posts ADD COLUMN image_url TEXT"); } catch (e) {}
}

// One-time migrations
function runMigrations() {
  initSchema();

  // Phase 0: initial JSON import
  const isMigrated = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get("initial_json_import");
  if (!isMigrated) {
    const jsonFile = process.env.DATA_FILE || path.join(__dirname, "data.json");
    let jsonData = null;
    if (fs.existsSync(jsonFile)) {
      try {
        jsonData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      } catch (err) {
        console.error("Migration: unable to parse data.json:", err.message);
      }
    }

    const insertCommunity = db.prepare(`
      INSERT OR IGNORE INTO communities (name, description, created_by, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, community_name, author_nick, title, body, comment_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertComment = db.prepare(`
      INSERT OR IGNORE INTO comments (id, post_id, author_nick, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const importTx = db.transaction(() => {
      let importedCount = 0;
      if (jsonData && Array.isArray(jsonData.communities) && jsonData.communities.length > 0) {
        for (const c of jsonData.communities) {
          insertCommunity.run(c.name, c.desc || "", c.by || "PingME", c.t || Date.now());
          importedCount++;
        }
        if (Array.isArray(jsonData.posts)) {
          for (const p of jsonData.posts) {
            insertCommunity.run(p.comm, "", "PingME", p.t || Date.now());
            const comments = Array.isArray(p.comments) ? p.comments : [];
            insertPost.run(p.id, p.comm, p.nick || "Guest", p.title || "", p.body || "", comments.length, p.t || Date.now());
            for (const cm of comments) {
              insertComment.run(cm.id, p.id, cm.nick || "Guest", cm.text || "", cm.t || Date.now());
            }
          }
        }
        console.log(`Migration: imported ${importedCount} communities from ${jsonFile}`);
      } else {
        const existingComm = db.prepare("SELECT COUNT(*) AS count FROM communities").get();
        if (existingComm.count === 0) {
          const now = Date.now();
          insertCommunity.run("cabs_city", "Need a cab? Post your trip, drivers reply with offers.", "PingME", now);
          insertCommunity.run("hotels_city", "Looking for a stay? Post your need, hosts reply with offers.", "PingME", now);
          insertPost.run("p1", "cabs_city", "Traveler-27", "Need a cab to the airport, 6 AM tomorrow", "2 people, 2 bags. Looking for a fixed fare.", 1, now);
          insertComment.run("c1", "p1", "Driver-81", "I can do it for ₹900, AC sedan.", now);
          console.log("Migration: seeded initial default communities and sample post");
        }
      }
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run("initial_json_import", Date.now());
    });
    importTx();
  }

  // Phase 1: add username_chosen column if missing
  const phase1 = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get("phase1_auth");
  if (!phase1) {
    db.transaction(() => {
      try {
        db.exec("ALTER TABLE users ADD COLUMN username_chosen INTEGER DEFAULT 0");
      } catch (e) {}
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run("phase1_auth", Date.now());
    })();
  }
}

runMigrations();

// Helper: build comment tree from flat list
function buildCommentTree(comments) {
  const map = {};
  const roots = [];

  for (const c of comments) {
    map[c.id] = { ...c, replies: [] };
  }

  for (const c of comments) {
    const node = map[c.id];
    if (c.parentId && map[c.parentId]) {
      map[c.parentId].replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ===== Database helper functions =====
const queries = {
  // --- User queries ---
  createUser: ({ id, username, recoveryHash, usernameChosen }) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, username, recovery_hash, username_chosen, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, username, recoveryHash || null, usernameChosen ? 1 : 0, now);
    return { id, username, usernameChosen: !!usernameChosen, created_at: now };
  },

  getUserById: (id) => {
    return db.prepare(`
      SELECT id, username, recovery_hash, role, karma, banned, username_chosen, created_at
      FROM users WHERE id = ?
    `).get(id);
  },

  getUserByUsername: (username) => {
    return db.prepare(`
      SELECT id, username, recovery_hash, role, karma, banned, username_chosen, created_at
      FROM users WHERE username = ?
    `).get(username);
  },

  getUserByRecoveryHash: (hash) => {
    return db.prepare(`
      SELECT id, username, recovery_hash, role, karma, banned, username_chosen, created_at
      FROM users WHERE recovery_hash = ?
    `).get(hash);
  },

  updateUsername: (userId, newUsername) => {
    db.prepare(`
      UPDATE users SET username = ?, username_chosen = 1 WHERE id = ?
    `).run(newUsername, userId);
  },

  // --- Session queries ---
  createSession: ({ tokenHash, userId }) => {
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)
    `).run(tokenHash, userId, Date.now());
  },

  getUserBySessionHash: (tokenHash) => {
    return db.prepare(`
      SELECT u.id, u.username, u.role, u.karma, u.banned, u.username_chosen, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash);
  },

  deleteSession: (tokenHash) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  },

  deleteUserSessions: (userId) => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  },

  // --- Community queries ---
  getCommunities: (userId = null, city = null) => {
    let selectJoined = "0 AS joined";
    let joinMembership = "";
    const params = [];
    if (userId) {
      selectJoined = "CASE WHEN m_user.user_id IS NOT NULL THEN 1 ELSE 0 END AS joined";
      joinMembership = "LEFT JOIN memberships m_user ON m_user.community_name = c.name AND m_user.user_id = ?";
      params.push(userId);
    }
    let cityClause = "";
    if (city) {
      cityClause = "WHERE LOWER(c.city) = LOWER(?)";
      params.push(city);
    }

    return db.prepare(`
      SELECT c.name, c.title, c.description, c.city, c.rules, c.created_by, c.created_at,
             COUNT(DISTINCT p.id) AS posts,
             COUNT(DISTINCT m.user_id) AS members,
             ${selectJoined}
      FROM communities c
      LEFT JOIN posts p ON p.community_name = c.name AND p.deleted_at IS NULL
      LEFT JOIN memberships m ON m.community_name = c.name
      ${joinMembership}
      ${cityClause}
      GROUP BY c.name
      ORDER BY c.created_at DESC
    `).all(...params).map(c => ({
      name: c.name,
      title: c.title,
      desc: c.description,
      city: c.city,
      rules: c.rules,
      by: c.created_by,
      t: c.created_at,
      posts: c.posts,
      members: c.members,
      joined: !!c.joined
    }));
  },

  getCommunity: (name, userId = null) => {
    let selectJoined = "0 AS joined";
    let joinMembership = "";
    const params = [name];
    if (userId) {
      selectJoined = "CASE WHEN m.user_id IS NOT NULL THEN 1 ELSE 0 END AS joined";
      joinMembership = "LEFT JOIN memberships m ON m.community_name = c.name AND m.user_id = ?";
      params.unshift(userId);
    }

    const c = db.prepare(`
      SELECT c.name, c.title, c.description, c.city, c.rules, c.created_by, c.created_at,
             (SELECT COUNT(*) FROM memberships WHERE community_name = c.name) AS members,
             ${selectJoined}
      FROM communities c
      ${joinMembership}
      WHERE c.name = ?
    `).get(...params);
    if (!c) return null;
    return {
      name: c.name,
      title: c.title,
      desc: c.description,
      city: c.city,
      rules: c.rules,
      by: c.created_by,
      t: c.created_at,
      members: c.members,
      joined: !!c.joined
    };
  },

  createCommunity: ({ name, description, createdBy, userId, city, rules }) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO communities (name, description, created_by, city, rules, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, description || "", createdBy || "Guest", city || null, rules || null, now);
    if (userId) {
      db.prepare(`
        INSERT OR IGNORE INTO memberships (community_name, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).run(name, userId, now);
    }
    return { name, description, createdBy, created_at: now };
  },

  getMemberCount: (communityName) => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE community_name = ?").get(communityName);
    return row ? row.n : 0;
  },

  isMember: (communityName, userId) => {
    if (!userId) return false;
    const row = db.prepare("SELECT 1 FROM memberships WHERE community_name = ? AND user_id = ?").get(communityName, userId);
    return !!row;
  },

  joinCommunity: (communityName, userId) => {
    const comm = db.prepare("SELECT name FROM communities WHERE name = ?").get(communityName);
    if (!comm) return null;
    db.prepare(`
      INSERT OR IGNORE INTO memberships (community_name, user_id, role, created_at)
      VALUES (?, ?, 'member', ?)
    `).run(communityName, userId, Date.now());
    const memberCount = queries.getMemberCount(communityName);
    return { joined: true, members: memberCount };
  },

  leaveCommunity: (communityName, userId) => {
    const comm = db.prepare("SELECT name FROM communities WHERE name = ?").get(communityName);
    if (!comm) return null;
    db.prepare("DELETE FROM memberships WHERE community_name = ? AND user_id = ?").run(communityName, userId);
    const memberCount = queries.getMemberCount(communityName);
    return { joined: false, members: memberCount };
  },

  getJoinedCommunities: (userId) => {
    return db.prepare(`
      SELECT c.name, c.title, c.description, c.city, c.rules, c.created_by, c.created_at,
             (SELECT COUNT(*) FROM posts p WHERE p.community_name = c.name AND p.deleted_at IS NULL) AS posts,
             (SELECT COUNT(*) FROM memberships m2 WHERE m2.community_name = c.name) AS members
      FROM memberships m
      JOIN communities c ON c.name = m.community_name
      WHERE m.user_id = ?
      ORDER BY m.created_at DESC
    `).all(userId).map(c => ({
      name: c.name,
      title: c.title,
      desc: c.description,
      city: c.city,
      rules: c.rules,
      by: c.created_by,
      t: c.created_at,
      posts: c.posts,
      members: c.members,
      joined: true
    }));
  },

  // --- Auto-expire old open requests (older than 7 days) ---
  autoExpirePosts: (maxAgeDays = 7) => {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    return db.prepare("UPDATE posts SET status = 'expired' WHERE status = 'open' AND created_at < ?").run(cutoff);
  },

  // --- Post queries with Hot, New, Top sorting & cursor pagination ---
  getPostsForCommunity: (communityName, { sort = "hot", t = "all", cursor = null, page = null, limit = 25, userId = null, type = null, status = null, city = null } = {}) => {
    // Auto-expire open posts older than 7 days
    queries.autoExpirePosts();

    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const now = Date.now();

    let timeFilter = "";
    const timeParams = [];
    if (t === "day") {
      timeFilter = "AND p.created_at >= ?";
      timeParams.push(now - 86400000);
    } else if (t === "week") {
      timeFilter = "AND p.created_at >= ?";
      timeParams.push(now - 604800000);
    } else if (t === "month") {
      timeFilter = "AND p.created_at >= ?";
      timeParams.push(now - 2592000000);
    }

    let extraFilter = "";
    const extraParams = [];
    if (type) {
      extraFilter += " AND UPPER(p.post_type) = UPPER(?)";
      extraParams.push(type);
    }
    if (status) {
      extraFilter += " AND LOWER(p.status) = LOWER(?)";
      extraParams.push(status);
    }
    if (city) {
      extraFilter += " AND (LOWER(p.city) = LOWER(?) OR LOWER(p.location) LIKE LOWER(?))";
      extraParams.push(city, `%${city}%`);
    }

    let orderSql = "";
    const orderParams = [];
    if (sort === "new") {
      orderSql = "ORDER BY p.created_at DESC, p.id DESC";
    } else if (sort === "top") {
      orderSql = "ORDER BY p.score DESC, p.created_at DESC, p.id DESC";
    } else {
      // sort === "hot": Time-decay formula
      // hot_score = (max(score, 0) + 1.0) / ((age_in_hours + 2.0) ^ 1.5)
      orderSql = "ORDER BY ((max(p.score, 0) + 1.0) / (((? - p.created_at) / 3600000.0 + 2.0) * sqrt((? - p.created_at) / 3600000.0 + 2.0))) DESC, p.created_at DESC, p.id DESC";
      orderParams.push(now, now);
    }

    const offset = page != null ? (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim : (cursor ? (cursor.offset || 0) : 0);

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total FROM posts p
      WHERE p.community_name = ? ${timeFilter} ${extraFilter}
    `).get(communityName, ...timeParams, ...extraParams);
    const total = totalRow ? totalRow.total : 0;

    const fetchLimit = lim + 1;
    let voteJoin = "";
    let voteSelect = "0 AS user_vote";
    const headParams = [];
    if (userId) {
      voteJoin = "LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.user_id = ?";
      voteSelect = "COALESCE(v.direction, 0) AS user_vote";
      headParams.push(userId);
    }

    const queryParams = [
      ...headParams,
      communityName,
      ...timeParams,
      ...extraParams,
      ...orderParams,
      fetchLimit,
      offset
    ];

    const sql = `
      SELECT p.id, p.community_name, p.user_id, p.author_nick, p.title, p.body,
             p.post_type, p.status, p.budget, p.target_time, p.location, p.city, p.image_url,
             p.score, p.upvotes, p.downvotes, p.comment_count, p.created_at, p.updated_at, p.deleted_at,
             u.completed_help_count AS author_completed,
             u.rating_sum AS author_rating_sum,
             u.rating_count AS author_rating_count,
             ${voteSelect}
      FROM posts p
      LEFT JOIN users u ON u.id = p.user_id
      ${voteJoin}
      WHERE p.community_name = ? ${timeFilter} ${extraFilter}
      ${orderSql}
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(sql).all(...queryParams);
    const hasMore = rows.length > lim;
    const posts = rows.slice(0, lim).map(p => {
      const isDeleted = !!p.deleted_at;
      const authorTrust = !isDeleted && p.author_nick !== "[deleted]" ? {
        completed: p.author_completed || 0,
        completedHelpCount: p.author_completed || 0,
        rating: p.author_rating_count > 0 ? parseFloat((p.author_rating_sum / p.author_rating_count).toFixed(1)) : null,
        ratingAverage: p.author_rating_count > 0 ? parseFloat((p.author_rating_sum / p.author_rating_count).toFixed(1)) : null,
        count: p.author_rating_count || 0,
        ratingCount: p.author_rating_count || 0
      } : null;

      return {
        id: p.id,
        communityName: p.community_name,
        community_name: p.community_name,
        userId: isDeleted ? null : p.user_id,
        user_id: isDeleted ? null : p.user_id,
        authorNick: isDeleted ? "[deleted]" : p.author_nick,
        author_nick: isDeleted ? "[deleted]" : p.author_nick,
        authorTrust,
        title: isDeleted ? "[deleted]" : p.title,
        body: isDeleted ? "[deleted]" : p.body,
        postType: p.post_type,
        post_type: p.post_type,
        status: p.status,
        budget: p.budget,
        targetTime: p.target_time,
        target_time: p.target_time,
        location: p.location,
        city: p.city,
        imageUrl: isDeleted ? null : p.image_url,
        image_url: isDeleted ? null : p.image_url,
        score: p.score,
        upvotes: p.upvotes,
        downvotes: p.downvotes,
        commentCount: p.comment_count,
        comment_count: p.comment_count,
        createdAt: p.created_at,
        created_at: p.created_at,
        updatedAt: p.updated_at,
        updated_at: p.updated_at,
        deleted: isDeleted,
        userVote: p.user_vote
      };
    });

    const nextCursor = hasMore ? { offset: offset + lim, sort, t, type, status, city } : null;

    return {
      posts,
      total,
      page: page != null ? parseInt(page, 10) : Math.floor(offset / lim) + 1,
      limit: lim,
      totalPages: Math.ceil(total / lim),
      hasMore,
      nextCursor
    };
  },

  getPostById: (id, userId = null) => {
    let voteSelect = "0 AS user_vote";
    let voteJoin = "";
    const params = [id];
    if (userId) {
      voteSelect = "COALESCE(v.direction, 0) AS user_vote";
      voteJoin = "LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.user_id = ?";
      params.unshift(userId);
    }

    const p = db.prepare(`
      SELECT p.id, p.community_name, p.user_id, p.author_nick, p.title, p.body,
             p.post_type, p.status, p.budget, p.target_time, p.location, p.city, p.image_url,
             p.score, p.upvotes, p.downvotes, p.comment_count, p.created_at, p.updated_at, p.deleted_at,
             u.completed_help_count AS author_completed,
             u.rating_sum AS author_rating_sum,
             u.rating_count AS author_rating_count,
             ${voteSelect}
      FROM posts p
      LEFT JOIN users u ON u.id = p.user_id
      ${voteJoin}
      WHERE p.id = ?
    `).get(...params);

    if (!p) return null;
    const isDeleted = !!p.deleted_at;
    const authorTrust = !isDeleted && p.author_nick !== "[deleted]" ? {
      completed: p.author_completed || 0,
      completedHelpCount: p.author_completed || 0,
      rating: p.author_rating_count > 0 ? parseFloat((p.author_rating_sum / p.author_rating_count).toFixed(1)) : null,
      ratingAverage: p.author_rating_count > 0 ? parseFloat((p.author_rating_sum / p.author_rating_count).toFixed(1)) : null,
      count: p.author_rating_count || 0,
      ratingCount: p.author_rating_count || 0
    } : null;

    return {
      id: p.id,
      communityName: p.community_name,
      community_name: p.community_name,
      userId: isDeleted ? null : p.user_id,
      user_id: isDeleted ? null : p.user_id,
      authorNick: isDeleted ? "[deleted]" : p.author_nick,
      author_nick: isDeleted ? "[deleted]" : p.author_nick,
      authorTrust,
      title: isDeleted ? "[deleted]" : p.title,
      body: isDeleted ? "[deleted]" : p.body,
      postType: p.post_type,
      post_type: p.post_type,
      status: p.status,
      budget: p.budget,
      targetTime: p.target_time,
      target_time: p.target_time,
      location: p.location,
      city: p.city,
      imageUrl: isDeleted ? null : p.image_url,
      image_url: isDeleted ? null : p.image_url,
      score: p.score,
      upvotes: p.upvotes,
      downvotes: p.downvotes,
      commentCount: p.comment_count,
      comment_count: p.comment_count,
      createdAt: p.created_at,
      created_at: p.created_at,
      updatedAt: p.updated_at,
      updated_at: p.updated_at,
      deleted: isDeleted,
      userVote: p.user_vote
    };
  },

  createPost: ({ id, communityName, userId, authorNick, title, body, postType, status, budget, targetTime, location, city, imageUrl }) => {
    const now = Date.now();
    const pType = (postType || "NEED").toUpperCase();
    const pStatus = status || "open";
    const pBudget = budget != null ? String(budget).trim().slice(0, 50) : null;
    const pImg = imageUrl ? String(imageUrl).trim().slice(0, 250) : null;
    db.prepare(`
      INSERT INTO posts (
        id, community_name, user_id, author_nick, title, body,
        post_type, status, budget, target_time, location, city, image_url,
        comment_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id, communityName, userId || null, authorNick || "Guest",
      title, body || "", pType, pStatus,
      pBudget, targetTime || null,
      location || null, city || null, pImg, now
    );
    return {
      id,
      communityName,
      community_name: communityName,
      authorNick,
      author_nick: authorNick,
      title,
      body,
      postType: pType,
      post_type: pType,
      status: pStatus,
      budget: pBudget,
      targetTime: targetTime || null,
      target_time: targetTime || null,
      location: location || null,
      city: city || null,
      imageUrl: pImg,
      image_url: pImg,
      created_at: now
    };
  },

  updatePostStatus: (id, userId, status) => {
    const post = db.prepare("SELECT id, user_id, community_name FROM posts WHERE id = ?").get(id);
    if (!post) return { error: "notFound" };
    const role = queries.getUserCommunityRole(post.community_name, userId);
    if (post.user_id !== userId && role !== "owner" && role !== "moderator") {
      return { error: "forbidden" };
    }
    const valid = ["open", "in_progress", "fulfilled", "expired"];
    if (!valid.includes(status)) return { error: "badRequest", message: "Invalid status." };

    const now = Date.now();
    db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    return { ok: true, id, status, updated_at: now };
  },

  editPost: (id, userId, { title, body }) => {
    const post = db.prepare("SELECT id, user_id, deleted_at FROM posts WHERE id = ?").get(id);
    if (!post || post.deleted_at) return { error: "notFound" };
    if (post.user_id !== userId) return { error: "forbidden" };
    const now = Date.now();
    db.prepare(`
      UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?
    `).run(title, body || "", now, id);
    return { ok: true, id, title, body: body || "", updated_at: now };
  },

  deletePost: (id, userId) => {
    const post = db.prepare("SELECT id, user_id, deleted_at FROM posts WHERE id = ?").get(id);
    if (!post || post.deleted_at) return { error: "notFound" };
    if (post.user_id !== userId) return { error: "forbidden" };
    const now = Date.now();
    db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?").run(now, id);
    return { ok: true, id, deleted: true, deleted_at: now };
  },

  // --- Voting (idempotent, supports posts and comments) ---
  castVote: ({ userId, targetType, targetId, direction }) => {
    if (![1, -1, 0].includes(direction)) {
      throw new Error("Invalid vote direction.");
    }
    if (!["post", "comment"].includes(targetType)) {
      throw new Error("Invalid vote target type.");
    }

    const table = targetType === "post" ? "posts" : "comments";

    return db.transaction(() => {
      const target = db.prepare(`SELECT id, score, upvotes, downvotes FROM ${table} WHERE id = ?`).get(targetId);
      if (!target) return null;

      const existing = db.prepare(`
        SELECT direction FROM votes
        WHERE user_id = ? AND target_type = ? AND target_id = ?
      `).get(userId, targetType, targetId);

      const oldDir = existing ? existing.direction : 0;
      if (oldDir === direction) {
        return {
          score: target.score,
          upvotes: target.upvotes,
          downvotes: target.downvotes,
          userVote: direction
        };
      }

      if (direction === 0) {
        db.prepare(`
          DELETE FROM votes
          WHERE user_id = ? AND target_type = ? AND target_id = ?
        `).run(userId, targetType, targetId);
      } else {
        db.prepare(`
          INSERT INTO votes (user_id, target_type, target_id, direction, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET direction = excluded.direction, created_at = excluded.created_at
        `).run(userId, targetType, targetId, direction, Date.now());
      }

      const scoreDiff = direction - oldDir;
      const upDiff = (direction === 1 ? 1 : 0) - (oldDir === 1 ? 1 : 0);
      const downDiff = (direction === -1 ? 1 : 0) - (oldDir === -1 ? 1 : 0);

      db.prepare(`
        UPDATE ${table}
        SET score = score + ?, upvotes = upvotes + ?, downvotes = downvotes + ?
        WHERE id = ?
      `).run(scoreDiff, upDiff, downDiff, targetId);

      const updated = db.prepare(`SELECT score, upvotes, downvotes FROM ${table} WHERE id = ?`).get(targetId);
      return {
        score: updated.score,
        upvotes: updated.upvotes,
        downvotes: updated.downvotes,
        userVote: direction
      };
    })();
  },

  // --- Nested Comments (max depth 5) ---
  getCommentsForPost: (postId, { userId = null } = {}) => {
    let voteSelect = "0 AS user_vote";
    let voteJoin = "";
    const params = [postId];
    if (userId) {
      voteSelect = "COALESCE(v.direction, 0) AS user_vote";
      voteJoin = "LEFT JOIN votes v ON v.target_type = 'comment' AND v.target_id = c.id AND v.user_id = ?";
      params.unshift(userId);
    }

    const rows = db.prepare(`
      SELECT c.id, c.post_id, c.parent_id, c.user_id, c.author_nick, c.body,
             c.score, c.upvotes, c.downvotes, c.depth, c.created_at, c.updated_at, c.deleted_at,
             u.completed_help_count AS author_completed,
             u.rating_sum AS author_rating_sum,
             u.rating_count AS author_rating_count,
             ${voteSelect}
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      ${voteJoin}
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `).all(...params);

    return rows.map(c => {
      const isDeleted = !!c.deleted_at;
      const authorTrust = !isDeleted && c.author_nick !== "[deleted]" ? {
        completed: c.author_completed || 0,
        completedHelpCount: c.author_completed || 0,
        rating: c.author_rating_count > 0 ? parseFloat((c.author_rating_sum / c.author_rating_count).toFixed(1)) : null,
        ratingAverage: c.author_rating_count > 0 ? parseFloat((c.author_rating_sum / c.author_rating_count).toFixed(1)) : null,
        count: c.author_rating_count || 0,
        ratingCount: c.author_rating_count || 0
      } : null;

      return {
        id: c.id,
        postId: c.post_id,
        post_id: c.post_id,
        parentId: c.parent_id,
        parent_id: c.parent_id,
        userId: isDeleted ? null : c.user_id,
        user_id: isDeleted ? null : c.user_id,
        authorNick: isDeleted ? "[deleted]" : c.author_nick,
        author_nick: isDeleted ? "[deleted]" : c.author_nick,
        authorTrust,
        body: isDeleted ? "[deleted]" : c.body,
        score: c.score,
        upvotes: c.upvotes,
        downvotes: c.downvotes,
        depth: c.depth,
        createdAt: c.created_at,
        created_at: c.created_at,
        updatedAt: c.updated_at,
        updated_at: c.updated_at,
        deleted: isDeleted,
        userVote: c.user_vote
      };
    });
  },

  getCommentById: (id) => {
    return db.prepare("SELECT * FROM comments WHERE id = ?").get(id);
  },

  createComment: ({ id, postId, parentId, userId, authorNick, body }) => {
    const now = Date.now();
    return db.transaction(() => {
      let depth = 0;
      if (parentId) {
        const parent = db.prepare("SELECT depth FROM comments WHERE id = ? AND post_id = ?").get(parentId, postId);
        if (!parent) {
          const err = new Error("Parent comment not found in this post.");
          err.statusCode = 400;
          throw err;
        }
        if (parent.depth >= 5) {
          const err = new Error("Maximum comment depth reached (max 5 levels).");
          err.statusCode = 400;
          throw err;
        }
        depth = parent.depth + 1;
      }

      db.prepare(`
        INSERT INTO comments (id, post_id, parent_id, user_id, author_nick, body, depth, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, postId, parentId || null, userId || null, authorNick || "Guest", body, depth, now);

      db.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?").run(postId);

      return {
        id,
        postId,
        parentId: parentId || null,
        userId,
        authorNick,
        body,
        depth,
        score: 0,
        createdAt: now
      };
    })();
  },

  editComment: (id, userId, text) => {
    const comment = db.prepare("SELECT id, user_id, deleted_at FROM comments WHERE id = ?").get(id);
    if (!comment || comment.deleted_at) return { error: "notFound" };
    if (comment.user_id !== userId) return { error: "forbidden" };
    const now = Date.now();
    db.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(text, now, id);
    return { ok: true, id, text, updated_at: now };
  },

  deleteComment: (id, userId) => {
    const comment = db.prepare("SELECT id, user_id, deleted_at FROM comments WHERE id = ?").get(id);
    if (!comment || comment.deleted_at) return { error: "notFound" };
    if (comment.user_id !== userId) return { error: "forbidden" };
    const now = Date.now();
    db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").run(now, id);
    return { ok: true, id, deleted: true, deleted_at: now };
  },

  // --- Search across communities and posts ---
  search: ({ q, type = "all", limit = 20 }) => {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const term = `%${q}%`;
    let communities = [];
    let posts = [];

    if (type === "all" || type === "communities") {
      communities = db.prepare(`
        SELECT c.name, c.title, c.description, c.city, c.rules, c.created_by, c.created_at,
               COUNT(DISTINCT p.id) AS posts,
               COUNT(DISTINCT m.user_id) AS members
        FROM communities c
        LEFT JOIN posts p ON p.community_name = c.name AND p.deleted_at IS NULL
        LEFT JOIN memberships m ON m.community_name = c.name
        WHERE c.name LIKE ? OR c.description LIKE ?
        GROUP BY c.name
        ORDER BY members DESC, posts DESC
        LIMIT ?
      `).all(term, term, lim).map(c => ({
        name: c.name,
        title: c.title,
        desc: c.description,
        city: c.city,
        rules: c.rules,
        by: c.created_by,
        t: c.created_at,
        posts: c.posts,
        members: c.members
      }));
    }

    if (type === "all" || type === "posts") {
      posts = db.prepare(`
        SELECT p.id, p.community_name, p.user_id, p.author_nick, p.title, p.body,
               p.score, p.comment_count, p.created_at
        FROM posts p
        WHERE (p.title LIKE ? OR p.body LIKE ?) AND p.deleted_at IS NULL
        ORDER BY p.score DESC, p.created_at DESC
        LIMIT ?
      `).all(term, term, lim).map(p => ({
        id: p.id,
        comm: p.community_name,
        nick: p.author_nick,
        title: p.title,
        body: p.body,
        score: p.score,
        comments: p.comment_count,
        t: p.created_at
      }));
    }

    return { communities, posts };
  },

  // --- Moderation & Roles ---
  getUserCommunityRole: (communityName, userId) => {
    if (!userId) return null;
    const comm = db.prepare("SELECT created_by FROM communities WHERE name = ?").get(communityName);
    if (!comm) return null;
    const user = db.prepare("SELECT username FROM users WHERE id = ?").get(userId);
    if (user && comm.created_by === user.username) return "owner";

    const mem = db.prepare("SELECT role FROM memberships WHERE community_name = ? AND user_id = ?").get(communityName, userId);
    return mem ? mem.role : null;
  },

  isUserBanned: (communityName, userId) => {
    if (!userId) return false;
    const user = db.prepare("SELECT banned FROM users WHERE id = ?").get(userId);
    if (user && user.banned) return true;
    if (communityName) {
      const ban = db.prepare("SELECT 1 FROM community_bans WHERE community_name = ? AND user_id = ?").get(communityName, userId);
      if (ban) return true;
    }
    return false;
  },

  banUser: ({ communityName, userId, bannedBy, reason, global = false }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      if (global) {
        db.prepare("UPDATE users SET banned = 1 WHERE id = ?").run(userId);
      }
      db.prepare(`
        INSERT INTO community_bans (community_name, user_id, banned_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(community_name, user_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at
      `).run(communityName, userId, bannedBy, reason || "", now);

      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'ban_user', 'user', ?, ?, ?)
      `).run(logId, communityName, bannedBy, userId, reason || "", now);

      return { ok: true, banned: true, userId, communityName };
    })();
  },

  unbanUser: ({ communityName, userId, moderatorId }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      db.prepare("DELETE FROM community_bans WHERE community_name = ? AND user_id = ?").run(communityName, userId);
      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'unban_user', 'user', ?, '', ?)
      `).run(logId, communityName, moderatorId, userId, now);
      return { ok: true, unbanned: true };
    })();
  },

  setModerator: ({ communityName, userId, appointedBy }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      db.prepare(`
        INSERT INTO memberships (community_name, user_id, role, created_at)
        VALUES (?, ?, 'moderator', ?)
        ON CONFLICT(community_name, user_id) DO UPDATE SET role = 'moderator'
      `).run(communityName, userId, now);

      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'appoint_moderator', 'user', ?, '', ?)
      `).run(logId, communityName, appointedBy, userId, now);

      return { ok: true, role: "moderator" };
    })();
  },

  removeModerator: ({ communityName, userId, removedBy }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      db.prepare(`
        UPDATE memberships SET role = 'member' WHERE community_name = ? AND user_id = ?
      `).run(communityName, userId);

      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'remove_moderator', 'user', ?, '', ?)
      `).run(logId, communityName, removedBy, userId, now);

      return { ok: true, role: "member" };
    })();
  },

  getCommunityModerators: (communityName) => {
    const comm = db.prepare("SELECT created_by FROM communities WHERE name = ?").get(communityName);
    const mods = db.prepare(`
      SELECT m.user_id, u.username, m.role, m.created_at
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.community_name = ? AND m.role IN ('owner', 'moderator')
      ORDER BY m.role DESC, m.created_at ASC
    `).all(communityName);

    return {
      ownerUsername: comm ? comm.created_by : null,
      moderators: mods
    };
  },

  updateCommunityRules: ({ communityName, rules, updatedBy }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      db.prepare("UPDATE communities SET rules = ? WHERE name = ?").run(rules, communityName);
      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'update_rules', 'community', ?, ?, ?)
      `).run(logId, communityName, updatedBy, communityName, (rules || "").slice(0, 200), now);
      return { ok: true, rules };
    })();
  },

  // --- Reports & Mod Queue ---
  createReport: ({ id, reporterId, targetType, targetId, communityName, reason }) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, community_name, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, reporterId, targetType, targetId, communityName, reason, now);
    return { id, targetType, targetId, communityName, reason, status: "pending", createdAt: now };
  },

  getReportsForCommunity: (communityName, status = "pending") => {
    const reports = db.prepare(`
      SELECT r.id, r.reporter_id, u.username AS reporter_nick, r.target_type, r.target_id,
             r.community_name, r.reason, r.status, r.created_at, r.resolved_by, r.resolved_at
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      WHERE r.community_name = ? AND (? = 'all' OR r.status = ?)
      ORDER BY r.created_at DESC
    `).all(communityName, status, status);

    return reports.map(r => {
      let targetInfo = null;
      if (r.target_type === "post") {
        const p = db.prepare("SELECT id, title, body, user_id, author_nick, deleted_at FROM posts WHERE id = ?").get(r.target_id);
        if (p) {
          targetInfo = {
            id: p.id,
            title: p.deleted_at ? "[deleted]" : p.title,
            body: p.deleted_at ? "[deleted]" : p.body,
            userId: p.user_id,
            authorNick: p.author_nick,
            deleted: !!p.deleted_at
          };
        }
      } else if (r.target_type === "comment") {
        const c = db.prepare("SELECT id, body, user_id, author_nick, deleted_at, post_id FROM comments WHERE id = ?").get(r.target_id);
        if (c) {
          targetInfo = {
            id: c.id,
            body: c.deleted_at ? "[deleted]" : c.body,
            userId: c.user_id,
            authorNick: c.author_nick,
            postId: c.post_id,
            deleted: !!c.deleted_at
          };
        }
      }
      return {
        id: r.id,
        reporterId: r.reporter_id,
        reporterNick: r.reporter_nick || "Anonymous",
        targetType: r.target_type,
        targetId: r.target_id,
        communityName: r.community_name,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at,
        target: targetInfo
      };
    });
  },

  dismissReport: ({ reportId, communityName, moderatorId }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      const rep = db.prepare("SELECT id, target_type, target_id FROM reports WHERE id = ? AND community_name = ?").get(reportId, communityName);
      if (!rep) return { error: "notFound" };

      db.prepare(`
        UPDATE reports SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE id = ?
      `).run(moderatorId, now, reportId);

      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'dismiss_report', ?, ?, 'Report dismissed', ?)
      `).run(logId, communityName, moderatorId, rep.target_type, rep.target_id, now);

      return { ok: true, status: "dismissed" };
    })();
  },

  resolveReportWithRemove: ({ reportId, communityName, moderatorId }) => {
    const now = Date.now();
    const logId = crypto.randomBytes(4).toString("hex");
    return db.transaction(() => {
      const rep = db.prepare("SELECT id, target_type, target_id FROM reports WHERE id = ? AND community_name = ?").get(reportId, communityName);
      if (!rep) return { error: "notFound" };

      if (rep.target_type === "post") {
        db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?").run(now, rep.target_id);
      } else if (rep.target_type === "comment") {
        db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").run(now, rep.target_id);
      }

      db.prepare(`
        UPDATE reports SET status = 'removed', resolved_by = ?, resolved_at = ? WHERE id = ?
      `).run(moderatorId, now, reportId);

      db.prepare(`
        INSERT INTO mod_logs (id, community_name, moderator_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'remove_content', ?, ?, 'Content removed via report', ?)
      `).run(logId, communityName, moderatorId, rep.target_type, rep.target_id, now);

      return { ok: true, status: "removed" };
    })();
  },

  getModLogs: (communityName, limit = 50) => {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    return db.prepare(`
      SELECT l.id, l.community_name, l.moderator_id, u.username AS moderator_nick,
             l.action, l.target_type, l.target_id, l.details, l.created_at
      FROM mod_logs l
      LEFT JOIN users u ON u.id = l.moderator_id
      WHERE l.community_name = ?
      ORDER BY l.created_at DESC
      LIMIT ?
    `).all(communityName, lim);
  },

  // --- Spam & Rate Checks ---
  checkRecentPost: ({ userId, title, body, cooldownMs = 30000, duplicateWindowMs = 600000 }) => {
    const now = Date.now();
    // 1. Cooldown
    if (cooldownMs > 0) {
      const lastPost = db.prepare(`
        SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(userId);

      if (lastPost && (now - lastPost.created_at) < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - (now - lastPost.created_at)) / 1000);
        return { error: "cooldown", remainingSec };
      }
    }

    // 2. Duplicate detection (exact title match or substantial non-empty body match in past 10 min)
    let dup = null;
    if (title) {
      dup = db.prepare(`
        SELECT id FROM posts
        WHERE user_id = ? AND title = ? AND created_at >= ? AND deleted_at IS NULL
        LIMIT 1
      `).get(userId, title, now - duplicateWindowMs);
    }
    if (!dup && body && body.trim().length > 10) {
      dup = db.prepare(`
        SELECT id FROM posts
        WHERE user_id = ? AND body = ? AND created_at >= ? AND deleted_at IS NULL
        LIMIT 1
      `).get(userId, body, now - duplicateWindowMs);
    }

    if (dup) {
      return { error: "duplicate" };
    }

    return { ok: true };
  },

  // --- Trust & Reputation ---
  getUserTrustBadge: (userId) => {
    if (!userId) return null;
    const u = db.prepare("SELECT completed_help_count, rating_sum, rating_count FROM users WHERE id = ?").get(userId);
    if (!u) return null;
    const avg = u.rating_count > 0 ? parseFloat((u.rating_sum / u.rating_count).toFixed(1)) : null;
    return {
      completedHelpCount: u.completed_help_count || 0,
      ratingAverage: avg,
      ratingCount: u.rating_count || 0
    };
  },

  // --- Private Deal Chat & Fulfillment ---
  createDealChat: ({ postId, authorId, helperId }) => {
    const post = db.prepare("SELECT id, user_id, title FROM posts WHERE id = ?").get(postId);
    if (!post) return { error: "notFound", message: "Post not found." };
    if (post.user_id !== authorId) return { error: "forbidden", message: "Only the post author can accept an offer." };
    if (authorId === helperId) return { error: "badRequest", message: "You cannot make a deal with yourself." };

    const helper = db.prepare("SELECT id, username FROM users WHERE id = ?").get(helperId);
    if (!helper) return { error: "notFound", message: "Helper not found." };

    return db.transaction(() => {
      // Check existing deal chat
      const existing = db.prepare(`
        SELECT id, post_id, author_id, helper_id, status, created_at
        FROM deal_chats WHERE post_id = ? AND helper_id = ?
      `).get(postId, helperId);

      if (existing) {
        return { ok: true, dealId: existing.id, chat: existing, existing: true };
      }

      const id = crypto.randomBytes(6).toString("hex");
      const now = Date.now();
      db.prepare(`
        INSERT INTO deal_chats (id, post_id, author_id, helper_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(id, postId, authorId, helperId, now, now);

      // Update post status to in_progress
      db.prepare("UPDATE posts SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, postId);

      return {
        ok: true,
        dealId: id,
        chat: { id, postId, authorId, helperId, status: "active", createdAt: now }
      };
    })();
  },

  getDealChat: (chatId, userId) => {
    const chat = db.prepare(`
      SELECT d.id, d.post_id, d.author_id, d.helper_id, d.status, d.rating, d.review, d.created_at, d.updated_at,
             p.title AS post_title, p.community_name, p.budget, p.target_time, p.location, p.city, p.post_type,
             ua.username AS author_nick,
             uh.username AS helper_nick,
             uh.completed_help_count AS helper_completed,
             uh.rating_sum AS helper_rating_sum,
             uh.rating_count AS helper_rating_count
      FROM deal_chats d
      JOIN posts p ON p.id = d.post_id
      JOIN users ua ON ua.id = d.author_id
      JOIN users uh ON uh.id = d.helper_id
      WHERE d.id = ?
    `).get(chatId);

    if (!chat) return null;
    if (chat.author_id !== userId && chat.helper_id !== userId) {
      return { error: "forbidden" };
    }

    const messages = db.prepare(`
      SELECT m.id, m.chat_id, m.sender_id, u.username AS sender_nick, m.body, m.created_at
      FROM deal_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ?
      ORDER BY m.created_at ASC
    `).all(chatId);

    const helperAvg = chat.helper_rating_count > 0 ? parseFloat((chat.helper_rating_sum / chat.helper_rating_count).toFixed(1)) : null;

    return {
      id: chat.id,
      postId: chat.post_id,
      authorId: chat.author_id,
      authorNick: chat.author_nick,
      helperId: chat.helper_id,
      helperNick: chat.helper_nick,
      helperTrust: {
        completed: chat.helper_completed || 0,
        completedHelpCount: chat.helper_completed || 0,
        rating: helperAvg,
        ratingAverage: helperAvg,
        count: chat.helper_rating_count || 0,
        ratingCount: chat.helper_rating_count || 0
      },
      status: chat.status,
      rating: chat.rating,
      review: chat.review,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      post: {
        id: chat.post_id,
        title: chat.post_title,
        community: chat.community_name,
        type: chat.post_type,
        budget: chat.budget,
        targetTime: chat.target_time,
        location: chat.location,
        city: chat.city
      },
      messages: messages.map(m => ({
        id: m.id,
        senderId: m.sender_id,
        senderNick: m.sender_nick,
        body: m.body,
        t: m.created_at
      }))
    };
  },

  sendDealMessage: ({ chatId, senderId, body }) => {
    const chat = db.prepare("SELECT id, author_id, helper_id, status FROM deal_chats WHERE id = ?").get(chatId);
    if (!chat) return { error: "notFound" };
    if (chat.author_id !== senderId && chat.helper_id !== senderId) return { error: "forbidden" };
    if (chat.status === "cancelled") return { error: "closed", message: "This deal has been cancelled." };
    if (chat.status === "fulfilled" || chat.status === "closed") return { error: "closed", message: "This deal has been fulfilled and closed." };

    const now = Date.now();
    const id = crypto.randomBytes(6).toString("hex");

    return db.transaction(() => {
      db.prepare(`
        INSERT INTO deal_messages (id, chat_id, sender_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, chatId, senderId, body, now);

      db.prepare("UPDATE deal_chats SET updated_at = ? WHERE id = ?").run(now, chatId);

      const sender = db.prepare("SELECT username FROM users WHERE id = ?").get(senderId);

      return {
        ok: true,
        message: {
          id,
          chatId,
          senderId,
          senderNick: sender ? sender.username : "User",
          body,
          t: now
        }
      };
    })();
  },

  fulfillDealChat: ({ chatId, authorId, rating, review }) => {
    const chat = db.prepare("SELECT id, post_id, author_id, helper_id, status FROM deal_chats WHERE id = ?").get(chatId);
    if (!chat) return { error: "notFound" };
    if (chat.author_id !== authorId) return { error: "forbidden", message: "Only the author who created the post can mark it fulfilled." };
    if (chat.status === "fulfilled") return { error: "alreadyFulfilled", message: "This deal is already marked fulfilled." };

    const rateNum = Math.min(Math.max(parseInt(rating, 10) || 5, 1), 5);
    const now = Date.now();

    return db.transaction(() => {
      // 1. Update deal chat
      db.prepare(`
        UPDATE deal_chats
        SET status = 'fulfilled', rating = ?, review = ?, updated_at = ?
        WHERE id = ?
      `).run(rateNum, review || "", now, chatId);

      // 2. Update post status to fulfilled
      db.prepare("UPDATE posts SET status = 'fulfilled', updated_at = ? WHERE id = ?").run(now, chat.post_id);

      // 3. Update helper trust rating
      db.prepare(`
        UPDATE users
        SET completed_help_count = completed_help_count + 1,
            rating_sum = rating_sum + ?,
            rating_count = rating_count + 1
        WHERE id = ?
      `).run(rateNum, chat.helper_id);

      const helper = db.prepare("SELECT completed_help_count, rating_sum, rating_count FROM users WHERE id = ?").get(chat.helper_id);
      const avg = helper && helper.rating_count > 0 ? parseFloat((helper.rating_sum / helper.rating_count).toFixed(1)) : null;

      return {
        ok: true,
        status: "fulfilled",
        rating: rateNum,
        review,
        helperTrust: {
          completed: helper ? helper.completed_help_count : 1,
          rating: avg,
          count: helper ? helper.rating_count : 1
        }
      };
    })();
  },

  getUserDeals: (userId) => {
    return db.prepare(`
      SELECT d.id, d.post_id, d.author_id, d.helper_id, d.status, d.rating, d.created_at, d.updated_at,
             p.title AS post_title, p.community_name, p.budget, p.city, p.post_type,
             ua.username AS author_nick,
             uh.username AS helper_nick,
             (SELECT body FROM deal_messages WHERE chat_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM deal_messages WHERE chat_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message_time
      FROM deal_chats d
      JOIN posts p ON p.id = d.post_id
      JOIN users ua ON ua.id = d.author_id
      JOIN users uh ON uh.id = d.helper_id
      WHERE d.author_id = ? OR d.helper_id = ?
      ORDER BY COALESCE(d.updated_at, d.created_at) DESC
    `).all(userId, userId).map(d => ({
      id: d.id,
      postId: d.post_id,
      post_id: d.post_id,
      postTitle: d.post_title,
      post_title: d.post_title,
      community: d.community_name,
      postType: d.post_type,
      budget: d.budget,
      city: d.city,
      status: d.status,
      rating: d.rating,
      isAuthor: d.author_id === userId,
      author_id: d.author_id,
      helper_id: d.helper_id,
      authorNick: d.author_nick,
      author_nick: d.author_nick,
      helperNick: d.helper_nick,
      helper_nick: d.helper_nick,
      otherNick: d.author_id === userId ? d.helper_nick : d.author_nick,
      lastMessage: d.last_message || "",
      last_message: d.last_message || "",
      lastMessageTime: d.last_message_time || d.created_at,
      updated_at: d.updated_at || d.created_at,
      created_at: d.created_at,
      t: d.updated_at || d.created_at
    }));
  },

  // --- In-App Notifications ---
  createNotification: ({ userId, type, title, body, link }) => {
    const id = crypto.randomBytes(6).toString("hex");
    const now = Date.now();
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, userId, type, title || "", body || "", link || "", now);

    return {
      id,
      userId,
      user_id: userId,
      type,
      title: title || "",
      body: body || "",
      link: link || "",
      read: 0,
      createdAt: now,
      created_at: now
    };
  },

  getNotifications: (userId, { limit = 40, unreadOnly = false } = {}) => {
    const filter = unreadOnly ? "AND read = 0" : "";
    const rows = db.prepare(`
      SELECT id, user_id, type, title, body, link, read, created_at
      FROM notifications
      WHERE user_id = ? ${filter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit);

    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      user_id: r.user_id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      read: !!r.read,
      createdAt: r.created_at,
      created_at: r.created_at
    }));
  },

  getUnreadNotificationCount: (userId) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read = 0").get(userId);
    return row ? row.count : 0;
  },

  markNotificationRead: (notificationId, userId) => {
    const res = db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?").run(notificationId, userId);
    return { ok: true, changed: res.changes > 0 };
  },

  markAllNotificationsRead: (userId) => {
    const res = db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0").run(userId);
    return { ok: true, changed: res.changes };
  }
};

module.exports = { db, DB_PATH, queries, buildCommentTree };
