const express = require("express");
const path = require("path");

const PORT = process.env.PORT || 4000;
const API_BASE = "https://rapi.flashproxy.com/api/v1";

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Server-side proxy: browser talks to this server only (same origin,
// no CORS), this server forwards to the real Flashproxy API and
// relays the response back. CORS is enforced by browsers, not
// servers, so this leg of the trip has no CORS restriction at all.
app.use("/api", async (req, res) => {
  const targetUrl = API_BASE + req.url;
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        Authorization: req.headers.authorization || "",
      },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(body);
  } catch (err) {
    res.status(502).json({
      success: false,
      error: { code: "PROXY_ERROR", message: err.message || "Failed to reach the Flashproxy API." },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Flashproxy-2 running at http://localhost:${PORT}`);
});
