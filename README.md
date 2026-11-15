# TagBack (PingME) – Community Help Platform

TagBack is a privacy-first community help and QR lost-and-found platform. Users can post local needs (e.g., airport cabs, local deliveries, hotel recommendations, emergency help) or offer services, discuss in nested Reddit-style threads, negotiate in private end-to-end deal chats, and build community trust badges—all without exposing their phone numbers or email addresses.

---

## Architecture Overview

The system is built on **Node.js 18+**, **Express 4**, and **SQLite (`better-sqlite3`)**, with a mobile-first, zero-framework vanilla JavaScript client served from `public/index.html`.

```
├── server.js               # Express application entry point & route mounting
├── db.js                   # SQLite schema, migrations, and parameterized queries
├── render.yaml             # Render infrastructure specification with persistent disk
├── middleware/
│   ├── auth.js             # Anonymous device sessions & cookie-based authentication
│   ├── rateLimit.js        # SQLite-persisted per-user and per-IP rate limiters
│   └── security.js         # Security headers (CSP, HSTS, X-Frame-Options), CORS, CSRF
├── routes/
│   ├── auth.js             # /api/auth (register, login, username, recovery)
│   ├── communities.js      # /api/communities (create, list, join, leave, rules, mods)
│   ├── posts.js            # /api/posts (create, vote, edit, soft-delete, SSE comments stream)
│   ├── comments.js         # /api/comments (vote, edit, soft-delete)
│   ├── deals.js            # /api/deals (private chats, message streaming, fulfillment, ratings)
│   ├── notifications.js    # /api/notifications (unread list, mark-as-read, SSE stream)
│   ├── search.js           # /api/search (cross-community and post search)
│   ├── reports.js          # /api/reports (content reporting & mod queue actions)
│   └── upload.js           # /api/upload (magic-byte validated image uploads)
├── lib/
│   ├── storage.js          # File storage interface with JPEG/PNG/WEBP signature verification
│   ├── events.js           # In-memory EventEmitter pub/sub for realtime SSE streams
│   └── utils.js            # Validation, sanitization, link/phone regexes, emergency rules
└── public/
    └── index.html          # Responsive single-page client with dark mode and live updates
```

---

## Key Features by Phase

1. **Phase 0 – Foundation & Database**:
   - Replaced flat JSON persistence with high-performance SQLite (`WAL` mode).
   - Dynamic schema migration imports legacy communities, posts, and comments seamlessly.
   - Configurable `DB_PATH` environment variable for persistent storage volumes.
2. **Phase 1 – Accounts & Identity**:
   - Device account generation with server-signed `httpOnly` session cookies.
   - Public unique `u/username` chosen once; prevents nickname spoofing across all write endpoints.
   - Reserved usernames and community names (`admin`, `official`, `pingme`, `support`, etc.).
   - Persistent rate limiting stored in SQLite across server restarts.
3. **Phase 2 – Reddit Core Mechanics**:
   - Idempotent upvoting/downvoting on posts and comments with score tracking.
   - Sorting algorithms: **Hot** (time-decay score formula: $\text{score} / (\text{age\_hours} + 2)^{1.5}$), **New**, and **Top** (day, week, all-time).
   - Cursor-based pagination on post feeds and comments.
   - Nested comments with parent hierarchy up to 5 levels deep, expand/collapse toggles.
   - Soft-delete semantics showing `[deleted]` while preserving reply hierarchy.
   - Full-text search across communities and posts.
4. **Phase 3 – Moderation & Safety**:
   - Role-based permissions: Community Owner, Moderator, and Member.
   - Report queue with moderator actions (remove content, dismiss report, ban user from community).
   - Comprehensive audit logging for all moderation events.
   - Anti-spam protections: blocking phone numbers and external links from new accounts (< 24h), post cooldowns, community creation age gates, and duplicate-post detection.
   - Deterministic emergency keyword safety checks with immediate **Call 112** banner prompts (no external AI dependency).
5. **Phase 4 – Local-Help & Trust**:
   - Structured post types: **NEED** and **OFFER** with budget/price, target date/time, area/landmark, and city fields.
   - Feed filtering by post type, status (Open, In Progress, Fulfilled, Expired), and city.
   - Automated expiration of stale open requests older than 7 days.
   - Private deal chats opened between author and helper upon offer acceptance. Contact information is never leaked publicly.
   - Community trust badges displaying completed help counts and average star ratings (1–5 stars).
6. **Phase 5 – Notifications & Realtime**:
   - In-app notification center for post replies, nested comment replies, accepted offers, deal messages, and mod actions.
   - Unread badge counter with real-time SSE stream updates.
   - Real-time Server-Sent Events (SSE) for instant comment delivery (< 100ms) without polling.
7. **Phase 6 – Production Hardening & UI Polish**:
   - Zero-dependency security headers: `Strict-Transport-Security` (HSTS), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`, and strict `Content-Security-Policy` (CSP).
   - Cross-Site Request Forgery (CSRF) validation on all mutating cookie-authenticated endpoints.
   - Strict 2MB image upload limit with magic-byte signature validation (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WEBP `RIFF...WEBP`).
   - Dark mode toggle with local storage persistence and OS preference detection.
   - Accessible buttons, labels, loading spinners, and empty-state placeholders.

---

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `DB_PATH` | File path for SQLite database | `tagback.db` |
| `DATA_FILE` | Path to legacy JSON data file for automatic migration | `data.json` |
| `UPLOADS_DIR` | Directory to store uploaded image files | `public/uploads` |
| `SESSION_SECRET` | Secret key used to sign session cookies | `tagback-default-secret-change-me` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | `""` (same-origin only) |
| `MIN_ACCOUNT_AGE_FOR_LINKS` | Milliseconds an account must exist before posting external links | `86400000` (24 hours) |
| `PLACE_KEY` | Admin key for physical place QR boards | Random hex string generated at boot |
| `ANTHROPIC_API_KEY` | Optional API key for Claude category suggestions on place boards | `""` (uses built-in fallback) |

---

## Local Development & Setup

### Prerequisites
- Node.js 18.0.0 or higher
- npm 9.0.0 or higher

### Installation
```bash
git clone https://github.com/your-username/tagback.git
cd tagback
npm install
```

### Running Automated Tests
The automated test suite verifies all functionality across Phases 0 through 6:
```bash
npm test
```
To run an individual phase test:
```bash
node test_phase0.js # Foundation, DB schema, migration & pagination
node test_phase1.js # Accounts, identity, recovery & rate limits
node test_phase2.js # Reddit mechanics, voting, sorting & nested comments
node test_phase3.js # Moderation, reports, spam & emergency rules
node test_phase4.js # Local help, structured fields, deals & trust badges
node test_phase5.js # Notifications, SSE streams & real-time delivery
node test_phase6.js # Security headers, CSRF, magic-byte image uploads
```

### Starting the Server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## Deploying to Render

Render deployment is automated via `render.yaml` with a persistent disk to retain SQLite data and uploaded photos across app restarts and deploys.

### Step-by-Step Deployment
1. Push your repository to GitHub or GitLab.
2. In the [Render Dashboard](https://dashboard.render.com), click **New** → **Blueprint**.
3. Connect your repository. Render will automatically parse `render.yaml`.
4. The blueprint provisions:
   - **Service**: Node web service (`npm install` / `npm start`).
   - **Persistent Disk**: Mounted at `/var/data` (1GB starter disk).
   - **Environment Variables**:
     - `DB_PATH`: `/var/data/tagback.db`
     - `UPLOADS_DIR`: `/var/data/uploads`
     - `SESSION_SECRET`: automatically generated cryptographically secure key.
5. Click **Apply Blueprint**. Render will build and deploy the application.

### Backup & Maintenance
- **Database Backup**: SQLite database resides at `/var/data/tagback.db`. You can create an online snapshot using SQLite CLI or Node.js via `.backup` or `VACUUM INTO '/var/data/backup.db'`.
- **Uploads Backup**: Images stored in `/var/data/uploads` can be archived using standard tar/rsync commands.

---

## Security Architecture

- **Authentication**: Signed HTTP-only session cookies with `SameSite=Lax`.
- **Authorization**: All write operations verify user identity server-side; client-supplied nicknames are ignored.
- **CSRF Protection**: Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) from session cookies validate `Origin` and `Referer` headers against host.
- **XSS Prevention**: Strict HTML escaping via `esc()` utility on all client-rendered text; input length limits enforced on both client and server.
- **Upload Safety**: Magic-byte signature verification prevents disguised executables or text scripts from being saved or served; strict 2MB limit.
- **Security Headers**: HSTS, CSP, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Permissions-Policy.
- **Emergency Safety**: Deterministic local keyword scanning prevents bypass and guarantees immediate Indian emergency dispatch (112) prompts without AI latency or third-party API dependencies.

