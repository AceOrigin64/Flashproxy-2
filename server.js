require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Redis } = require("@upstash/redis");

const PORT = process.env.PORT || 4000;
const API_BASE = "https://rapi.flashproxy.com/api/v1";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const AUDIT_LOG_MAX_ENTRIES = 500;
const CLIENTS_HISTORY_MAX_ENTRIES = 500;
// The Redis list is shared across every reseller key, then filtered by
// key per-read, so it needs more headroom than the per-key cap above or
// one busy key could push another key's older entries out entirely.
const CLIENTS_HISTORY_SHARED_LIST_CAP = 5000;

// On Vercel the filesystem is read-only outside /tmp AND not shared
// across invocations -- a fresh instance has an empty /tmp, so file
// storage there only ever lasts for the life of one warm container.
// Real persistence needs a real store, so we use Upstash Redis when
// its env vars are present (set by `vercel install upstash/upstash-kv`)
// and fall back to local files otherwise -- `npm start` works with
// zero extra setup, no Redis required for local development.
const redis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null;

const AUDIT_LOG_PATH = path.join(os.tmpdir(), "flashproxy2-audit.log");
const CLIENTS_HISTORY_PATH = path.join(os.tmpdir(), "flashproxy2-clients-history.log");
const CLIENTS_SNAPSHOT_PATH = path.join(os.tmpdir(), "flashproxy2-clients-snapshot.json");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function maskKey(key) {
  if (!key) return "(none)";
  return key.length > 8 ? `${key.slice(0, 8)}••••${key.slice(-4)}` : "••••";
}

function getBearerKey(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

async function appendAudit(entry) {
  const line = JSON.stringify(entry);
  if (redis) {
    await redis.lpush("flashproxy2:audit", line);
    await redis.ltrim("flashproxy2:audit", 0, AUDIT_LOG_MAX_ENTRIES - 1);
    return;
  }
  fs.appendFile(AUDIT_LOG_PATH, line + "\n", () => {});
}

async function readAuditLog() {
  if (redis) {
    const items = await redis.lrange("flashproxy2:audit", 0, AUDIT_LOG_MAX_ENTRIES - 1);
    return items
      .map((line) => {
        try {
          return typeof line === "string" ? JSON.parse(line) : line;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-AUDIT_LOG_MAX_ENTRIES)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function appendClientHistory(entry) {
  const line = JSON.stringify(entry);
  if (redis) {
    await redis.lpush("flashproxy2:clients-history", line);
    await redis.ltrim("flashproxy2:clients-history", 0, CLIENTS_HISTORY_SHARED_LIST_CAP - 1);
    return;
  }
  fs.appendFile(CLIENTS_HISTORY_PATH, line + "\n", () => {});
}

async function readClientHistory(rawKey) {
  if (redis) {
    const items = await redis.lrange("flashproxy2:clients-history", 0, CLIENTS_HISTORY_SHARED_LIST_CAP - 1);
    return items
      .map((line) => {
        try {
          return typeof line === "string" ? JSON.parse(line) : line;
        } catch {
          return null;
        }
      })
      .filter((e) => e && e._k === rawKey)
      .slice(0, CLIENTS_HISTORY_MAX_ENTRIES)
      .map(({ _k, ...rest }) => rest);
  }
  if (!fs.existsSync(CLIENTS_HISTORY_PATH)) return [];
  const lines = fs.readFileSync(CLIENTS_HISTORY_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e._k === rawKey)
    .slice(-CLIENTS_HISTORY_MAX_ENTRIES)
    .reverse()
    .map(({ _k, ...rest }) => rest);
}

async function getClientSnapshot(rawKey) {
  if (redis) {
    const raw = await redis.get(`flashproxy2:clients-snapshot:${rawKey}`);
    if (!raw) return [];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  if (!fs.existsSync(CLIENTS_SNAPSHOT_PATH)) return [];
  try {
    const snapshot = JSON.parse(fs.readFileSync(CLIENTS_SNAPSHOT_PATH, "utf8"));
    return snapshot[rawKey] || [];
  } catch {
    return [];
  }
}

async function setClientSnapshot(rawKey, refs) {
  if (redis) {
    await redis.set(`flashproxy2:clients-snapshot:${rawKey}`, JSON.stringify(refs));
    return;
  }
  let snapshot = {};
  if (fs.existsSync(CLIENTS_SNAPSHOT_PATH)) {
    try {
      snapshot = JSON.parse(fs.readFileSync(CLIENTS_SNAPSHOT_PATH, "utf8"));
    } catch {
      snapshot = {};
    }
  }
  snapshot[rawKey] = refs;
  fs.writeFile(CLIENTS_SNAPSHOT_PATH, JSON.stringify(snapshot), () => {});
}

// Flashproxy's API has no "client added/removed" event log of its own --
// a client here is just an end_user_reference tag on a plan, and plans
// never disappear once created (they just change status). So this is
// our own bookkeeping: every time /plans is fetched, diff the set of
// client references against the last snapshot for that exact key and
// log what's new. "Removed" will rarely fire (Flashproxy keeps plan
// history visible), which is real behavior, not a bug.
async function trackClientHistory(rawKey, plansResponseBody) {
  if (!rawKey) return;
  try {
    const parsed = JSON.parse(plansResponseBody);
    if (!parsed?.success || !Array.isArray(parsed?.data?.plans)) return;

    const currentRefs = new Set(parsed.data.plans.map((p) => p.end_user_reference || "Unassigned"));
    const knownRefs = new Set(await getClientSnapshot(rawKey));
    const ts = new Date().toISOString();
    const maskedKey = maskKey(rawKey);

    const events = [];
    currentRefs.forEach((ref) => {
      if (!knownRefs.has(ref)) events.push({ ts, event: "added", client: ref, key: maskedKey, _k: rawKey });
    });
    knownRefs.forEach((ref) => {
      if (!currentRefs.has(ref)) events.push({ ts, event: "removed", client: ref, key: maskedKey, _k: rawKey });
    });

    await Promise.all(events.map((e) => appendClientHistory(e)));
    await setClientSnapshot(rawKey, Array.from(currentRefs));
  } catch {
    // malformed/unexpected response shape -- skip tracking this cycle
  }
}

// ---------------------------------------------------------------------
// Internal admin routes -- registered before the /api proxy catch-all
// so they're handled here instead of being forwarded to Flashproxy.
// "Admin" is a local-only concept: whoever holds ADMIN_API_KEY (set in
// the gitignored .env file, never committed) sees the audit log.
// Flashproxy's own API has no role/admin field to check against.
// ---------------------------------------------------------------------

app.get("/api/_internal/whoami", (req, res) => {
  const key = getBearerKey(req);
  const isAdmin = Boolean(ADMIN_API_KEY) && key === ADMIN_API_KEY;
  res.json({ success: true, data: { isAdmin } });
});

app.get("/api/_internal/audit-log", async (req, res) => {
  const key = getBearerKey(req);
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin access required." },
    });
  }
  res.json({ success: true, data: { entries: await readAuditLog() } });
});

app.get("/api/_internal/client-history", async (req, res) => {
  const key = getBearerKey(req);
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin access required." },
    });
  }
  res.json({ success: true, data: { entries: await readClientHistory(key) } });
});

// Server-side proxy: browser talks to this server only (same origin,
// no CORS), this server forwards to the real Flashproxy API and
// relays the response back. CORS is enforced by browsers, not
// servers, so this leg of the trip has no CORS restriction at all.
app.use("/api", async (req, res) => {
  const targetUrl = API_BASE + req.url;
  const rawKey = getBearerKey(req);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        Authorization: req.headers.authorization || "",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(req.headers["x-idempotency-key"] ? { "X-Idempotency-Key": req.headers["x-idempotency-key"] } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const body = await upstream.text();
    await appendAudit({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      key: maskKey(rawKey),
      status: upstream.status,
      ip: req.ip,
    });
    if (req.method === "GET" && req.url.split("?")[0] === "/plans" && upstream.status === 200) {
      await trackClientHistory(rawKey, body);
    }
    res.status(upstream.status);
    res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(body);
  } catch (err) {
    await appendAudit({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      key: maskKey(rawKey),
      status: 502,
      ip: req.ip,
      error: err.message,
    });
    res.status(502).json({
      success: false,
      error: { code: "PROXY_ERROR", message: err.message || "Failed to reach the Flashproxy API." },
    });
  }
});

// Vercel's Node builder imports this file and calls the exported app
// directly per-request -- it never calls listen(). Local `npm start`
// still needs the real listener, so only start one when this file is
// run directly (not imported as a module).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Flashproxy-2 running at http://localhost:${PORT}`);
  });
}

module.exports = app;
