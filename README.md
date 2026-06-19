# Flashproxy-2

Standalone Flashproxy reseller dashboard. No browser extension required — runs as a normal local website.

![Usage Tab After Loading Completely](screenshots/usage-tab-after-loading-completely.png)

## Why this exists

The [Flashproxy-API-Dashboard](https://github.com/AceOrigin64/Flashproxy-API-Dashboard) browser extension kept hitting CORS errors when fetching the real API directly from the browser. This version sidesteps that entirely: a small Node/Express server proxies API calls server-side, so the browser only ever talks to `localhost` (same-origin, no CORS possible).

## How it works

- `server.js` serves the static UI (`public/`) and proxies any request to `/api/*` over to `https://rapi.flashproxy.com/api/v1/*`, forwarding your `Authorization` header.
- The browser never talks cross-origin to Flashproxy's API directly — only to this local server.
- Login validates against the real `GET /balance` endpoint. No mock data anywhere.
- An `ADMIN_API_KEY` set in a local `.env` file (gitignored, never committed) unlocks an Admin Panel for that one key — audit logging, per-client breakdowns, and client history tracking. Flashproxy's own API has no "admin" or "role" concept; this is purely local to this dashboard.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:4000** and log in with your real Flashproxy API key.

Optional: create a `.env` file with `ADMIN_API_KEY=your_key_here` to unlock the Admin Panel for that key.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server: static hosting, `/api/*` proxy to the real Flashproxy API, audit logging, client-history tracking, admin-only internal routes |
| `.env` | Local-only, gitignored. Holds `ADMIN_API_KEY` |
| `audit.log` | Local-only, gitignored. Every proxied API request: time, method, path, masked key, status |
| `clients-history.log` / `clients-snapshot.json` | Local-only, gitignored. Tracks when a client (`end_user_reference`) is first seen or disappears from `/plans` |
| `public/index.html` | Markup for all five pages: Welcome, Login, Dashboard, Admin Panel, Client History |
| `public/styles.css` | Theming (brand purple/blue gradients, orange admin theme, black/white history theme) and page transitions |
| `public/app.js` | Login flow, dashboard views, admin views, all fetched live — no mock data |

## Pages

- **Welcome** — animated intro, brand gradient text
- **Login** — enter your Flashproxy API key, validated against the real API
- **Dashboard** — sidebar nav: Overview, Balance, Plans, Dedicated ISP, Metrics, Sub-Users, Usage, all live. A white "History" button (admin-only, reached via the Admin Panel) and an orange "Audit (Admin)" button appear only for the configured admin key
- **Admin Panel** (orange/white, admin key only) — Users (all clients, active/inactive toggle), Client Information (per-client bandwidth + speed graphs), Reseller Information (this reseller's own active/past plans), Audit Log (every API call this server has proxied)
- **Client History** (black/white, nested inside the Admin Panel) — every client added or removed, with real timestamps, derived by diffing successive `/plans` fetches since Flashproxy's API has no such event log of its own

## Development History

This project grew entirely through iterative chat requests in one continuous session (dated 2026-06-19) — there's no wall-clock timestamp per request, so this is the actual chronological order they happened in, grouped by theme, with the reasoning behind each:

**1. Why this project exists at all**
A separate browser-extension version of this dashboard kept failing with CORS errors when calling the real Flashproxy API directly from a tab page. Rather than keep patching that architecture, the request was to rebuild it as a standalone site with its own server, so the server (not the browser) talks to Flashproxy — sidestepping CORS permanently. That's the whole reason Flashproxy-2 exists as a separate repo from Flashproxy-API-Dashboard.

**2. Getting the live API actually connected**
Once the server existed, the priority was making sure it only ever showed real data: real login validation against `/balance`, real numbers everywhere, no hardcoded/mock keys. This was reaffirmed more than once — at one point a hardcoded-key shortcut was tried and then explicitly reversed, with the instruction to only ever use the live API and only allow login with a genuinely authorized key.

**3. Branding and animation passes**
Several rounds went into matching flashproxy.com's actual look: pulling real hex colors from the live site's CSS, adjusting the Welcome/Login page gradients and text colors repeatedly (purple shade tweaks, light-purple vs cyan accents, font sizing), and reworking the intro animation (letter-by-letter reveal, removing the reveal from the Login page specifically, slowing/speeding transitions). Each pass was a direct visual correction after seeing the previous result — "too big," "not visible," "make it lighter," etc.

**4. Building out the real dashboard views**
Overview, Balance, Plans, Dedicated ISP, Metrics, Sub-Users, and Usage tabs were built one at a time against the real API. Several required bug fixes once real API responses didn't match the docs' example shapes (e.g. `/plans` returns `data.plans`, not `data.items`; `/sub-users` returns `sub_users`, not `items`) — those were fixed by checking the actual OpenAPI spec (`/openapi.json`) rather than guessing.

**5. Graphs and the "no time-series" constraint**
Throughput and usage graphs were requested with hour/day/week-style toggles. The real API only exposes a single aggregate value per requested window (no per-minute history endpoint), so every graph here plots a real axis and real toggle, but the line sits at 0 with the actual aggregate number shown as a caption — chosen deliberately over fabricating a fake trend line. The toggle intervals were corrected partway through from 24h/48h/72h/1w/2w/3w to the simpler 1hr/3hr/6hrs/12hrs/24hrs format, which became the standard for every later graph.

**6. The Admin Panel**
Requested as a way to see "who is using the dashboard and what they do," with the design (auth, access control, logging) left open. The approach taken: an `ADMIN_API_KEY` in a gitignored `.env` (never the literal key hardcoded into committed source, to avoid leaking it via GitHub), an orange-themed panel only that key can reach, with Users / Client Information / Reseller Information / Audit Log tabs added one at a time. "Reseller Information" originally included a "future purchases" section, which was removed once it became clear Flashproxy's API has no scheduled-purchase concept — nothing to show there truthfully.

**7. Client History**
A follow-up to the Admin Panel: track every client ever added or removed. Flashproxy's API doesn't expose this as an event log, so the server diffs the client list (`end_user_reference` values) on every `/plans` fetch against a saved snapshot, logging real "added"/"removed" events. Originally placed as a button on the main dashboard, then moved (per explicit correction) to live only inside the Admin Panel, gated the same way as the rest of the admin features, since it shouldn't be visible to non-admin resellers.

**8. Polish pass**
Final round of smaller corrections: pill colors, font choices for graph axes (JetBrains Mono for a more "formal/robotic" numeric look), Mbps→MBps unit conversion with a proper 0–60 grading, sorting active clients above inactive ones regardless of join order, and a clickable/animated Flashproxy brand link in the sidebar that opens the real flashproxy.com site.

Every step above was a direct response to a specific request in chat — nothing here was built speculatively ahead of being asked for.
