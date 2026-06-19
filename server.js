require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 4000;
const API_BASE = "https://rapi.flashproxy.com/api/v1";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const AUDIT_LOG_PATH = path.join(__dirname, "audit.log");
const AUDIT_LOG_MAX_ENTRIES = 500;
const CLIENTS_HISTORY_PATH = path.join(__dirname, "clients-history.log");
const CLIENTS_SNAPSHOT_PATH = path.join(__dirname, "clients-snapshot.json");
const CLIENTS_HISTORY_MAX_ENTRIES = 500;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function maskKey(key) {
  if (!key) return "(none)";
  return key.length > 8 ? `${key.slice(0, 8)}••••${key.slice(-4)}` : "••••";
}

function appendAudit(entry) {
  fs.appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", () => {});
}

function readAuditLog() {
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

function getBearerKey(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function appendClientHistory(entry) {
  fs.appendFile(CLIENTS_HISTORY_PATH, JSON.stringify(entry) + "\n", () => {});
}

function readClientHistory(rawKey) {
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

// Flashproxy's API has no "client added/removed" event log of its own --
// a client here is just an end_user_reference tag on a plan, and plans
// never disappear once created (they just change status). So this is
// our own bookkeeping: every time /plans is fetched, diff the set of
// client references against the last snapshot for that exact key and
// log what's new. "Removed" will rarely fire (Flashproxy keeps plan
// history visible), which is real behavior, not a bug.
function trackClientHistory(rawKey, plansResponseBody) {
  if (!rawKey) return;
  try {
    const parsed = JSON.parse(plansResponseBody);
    if (!parsed?.success || !Array.isArray(parsed?.data?.plans)) return;

    const currentRefs = new Set(parsed.data.plans.map((p) => p.end_user_reference || "Unassigned"));

    let snapshot = {};
    if (fs.existsSync(CLIENTS_SNAPSHOT_PATH)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(CLIENTS_SNAPSHOT_PATH, "utf8"));
      } catch {
        snapshot = {};
      }
    }
    const knownRefs = new Set(snapshot[rawKey] || []);
    const ts = new Date().toISOString();
    const maskedKey = maskKey(rawKey);

    currentRefs.forEach((ref) => {
      if (!knownRefs.has(ref)) {
        appendClientHistory({ ts, event: "added", client: ref, key: maskedKey, _k: rawKey });
      }
    });
    knownRefs.forEach((ref) => {
      if (!currentRefs.has(ref)) {
        appendClientHistory({ ts, event: "removed", client: ref, key: maskedKey, _k: rawKey });
      }
    });

    snapshot[rawKey] = Array.from(currentRefs);
    fs.writeFile(CLIENTS_SNAPSHOT_PATH, JSON.stringify(snapshot), () => {});
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

app.get("/api/_internal/audit-log", (req, res) => {
  const key = getBearerKey(req);
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin access required." },
    });
  }
  res.json({ success: true, data: { entries: readAuditLog() } });
});

app.get("/api/_internal/client-history", (req, res) => {
  const key = getBearerKey(req);
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin access required." },
    });
  }
  res.json({ success: true, data: { entries: readClientHistory(key) } });
});

// Server-side proxy: browser talks to this server only (same origin,
// no CORS), this server forwards to the real Flashproxy API and
// relays the response back. CORS is enforced by browsers, not
// servers, so this leg of the trip has no CORS restriction at all.
app.use("/api", async (req, res) => {
  const targetUrl = API_BASE + req.url;
  const rawKey = getBearerKey(req);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        Authorization: req.headers.authorization || "",
      },
    });
    const body = await upstream.text();
    appendAudit({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      key: maskKey(rawKey),
      status: upstream.status,
      ip: req.ip,
    });
    if (req.method === "GET" && req.url.split("?")[0] === "/plans" && upstream.status === 200) {
      trackClientHistory(rawKey, body);
    }
    res.status(upstream.status);
    res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(body);
  } catch (err) {
    appendAudit({
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

app.listen(PORT, () => {
  console.log(`Flashproxy-2 running at http://localhost:${PORT}`);
});
