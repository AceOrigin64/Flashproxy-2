# Flashproxy-2

Standalone Flashproxy reseller dashboard. No browser extension required — runs as a normal local website.

## Why this exists

The [Flashproxy-API-Dashboard](https://github.com/AceOrigin64/Flashproxy-API-Dashboard) browser extension kept hitting CORS errors when fetching the real API directly from the browser. This version sidesteps that entirely: a small Node/Express server proxies API calls server-side, so the browser only ever talks to `localhost` (same-origin, no CORS possible).

## How it works

- `server.js` serves the static UI (`public/`) and proxies any request to `/api/*` over to `https://rapi.flashproxy.com/api/v1/*`, forwarding your `Authorization` header.
- The browser never talks cross-origin to Flashproxy's API directly — only to this local server.
- Login validates against the real `GET /balance` endpoint. No mock data anywhere.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:4000** and log in with your real Flashproxy API key.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server: static file hosting + `/api/*` proxy to the real Flashproxy API |
| `public/index.html` | Welcome / Login / Dashboard page markup |
| `public/styles.css` | Purple/white/black themed styling, page transitions |
| `public/app.js` | Login flow, dashboard views (Overview, Balance, Plans, Dedicated ISP, Metrics, Sub-Users, Usage), all fetched live |

## Pages

- **Welcome** — animated intro
- **Login** — enter your Flashproxy API key
- **Dashboard** — sidebar nav across Overview, Balance, Plans, Dedicated ISP, Metrics, Sub-Users, Usage, all populated from live API data
