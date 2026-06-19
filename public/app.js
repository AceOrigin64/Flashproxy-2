let currentApiKey = null;

const welcomePage = document.getElementById("page-welcome");
const loginPage = document.getElementById("page-login");
const appPage = document.getElementById("page-app");
const adminPage = document.getElementById("page-admin");
const historyPage = document.getElementById("page-history");

document.getElementById("brand-link").addEventListener("click", () => {
  window.open("https://www.flashproxy.com", "_blank");
});

function revealLetters(el, stepSeconds = 0.045, baseDelay = 0) {
  const lines = el.innerHTML.split(/<br\s*\/?>/i);
  let globalIndex = 0;
  el.innerHTML = lines
    .map((line) =>
      [...line]
        .map((ch) => {
          const delay = (baseDelay + globalIndex * stepSeconds).toFixed(3);
          globalIndex++;
          const content = ch === " " ? "&nbsp;" : ch;
          return `<span class="letter" style="animation-delay:${delay}s">${content}</span>`;
        })
        .join("")
    )
    .join("<br/>");
}

revealLetters(document.querySelector("#page-welcome .hero-title"), 0.045, 0.6);

setTimeout(() => {
  welcomePage.classList.add("leaving");
  loginPage.classList.add("entering");
  // The logo+text lives outside both pages (fixed, shared), so it never
  // moves during the page transition -- only this shrink in place,
  // timed to the same 1.8s duration as the page's own fade/scale. Sits
  // at 2x on the Welcome page (baked into the fadeUpCenter keyframe),
  // shrinks to 1x for the Login page. Switches to dark text at the
  // same moment since Login's background is light (Welcome's is dark
  // purple, needing white text).
  const sharedLogo = document.getElementById("shared-logo");
  sharedLogo.classList.add("on-light");
  sharedLogo.animate(
    [{ transform: "translateX(calc(-50% - 25px)) scale(2)" }, { transform: "translateX(calc(-50% - 25px)) scale(1)" }],
    { duration: 1800, easing: "ease", fill: "forwards" }
  );
}, 3200);

// ---------------------------------------------------------------------
// API client -- fetches this same server's /api/* route, which proxies
// server-side to the real Flashproxy API. Same-origin request, so the
// browser never needs CORS permission for rapi.flashproxy.com at all.
// ---------------------------------------------------------------------

async function apiGet(path) {
  let res;
  try {
    res = await fetch("/api" + path, {
      headers: { Authorization: `Bearer ${currentApiKey}` },
    });
  } catch {
    throw new Error("Couldn't reach the local server. Make sure `node server.js` is still running.");
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Unexpected response (${res.status})`);
  }
  if (!res.ok || json.success === false) {
    throw new Error(json?.error?.message || `Request failed (${res.status})`);
  }
  return json.data;
}

// POST helper that does NOT throw on non-2xx -- purchase flows need to
// branch on the exact status (402 insufficient balance vs. other
// errors), not just fail generically.
async function apiPost(path, body, idempotencyKey) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentApiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, json: null, networkError: true };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response, leave json null
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------
// Login -- the entered key must be accepted by the real /balance
// endpoint. Wrong or missing key -> server's own error message.
// ---------------------------------------------------------------------

const loginForm = document.getElementById("login-form");
const loginSubmitButton = loginForm.querySelector(".outline-button");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = document.getElementById("api-key").value.trim();
  const errorEl = document.getElementById("login-error");

  if (!apiKey) {
    errorEl.textContent = "Enter your Flashproxy API key.";
    return;
  }

  errorEl.textContent = "";
  loginSubmitButton.disabled = true;
  loginSubmitButton.textContent = "Connecting...";

  currentApiKey = apiKey;
  try {
    await apiGet("/balance");
    document.getElementById("app-key-badge").innerHTML = `Connected with <code>${maskKey(apiKey)}</code>`;
    loginPage.classList.add("leaving");
    appPage.classList.add("entering");
    document.getElementById("shared-logo").classList.add("hidden");
    renderView("overview");
    const who = await apiGet("/_internal/whoami").catch(() => ({ isAdmin: false }));
    document.getElementById("audit-log-button").classList.toggle("hidden", !who.isAdmin);
  } catch (err) {
    currentApiKey = null;
    errorEl.textContent = err.message || "Could not connect with that API key.";
  } finally {
    loginSubmitButton.disabled = false;
    loginSubmitButton.textContent = "Continue";
  }
});

document.getElementById("logout-button").addEventListener("click", () => {
  currentApiKey = null;
  appPage.classList.remove("entering");
  loginPage.classList.remove("leaving");
  document.getElementById("api-key").value = "";
  document.getElementById("login-error").textContent = "";
  document.getElementById("audit-log-button").classList.add("hidden");
  document.getElementById("shared-logo").classList.remove("hidden");
});

document.getElementById("audit-log-button").addEventListener("click", () => {
  appPage.classList.add("leaving");
  adminPage.classList.add("entering");
  renderAdminView("users");
});

document.getElementById("admin-back-button").addEventListener("click", () => {
  adminPage.classList.remove("entering");
  appPage.classList.remove("leaving");
});

document.getElementById("history-button").addEventListener("click", () => {
  adminPage.classList.add("leaving");
  historyPage.classList.add("entering");
  renderHistoryView();
});

document.getElementById("history-back-button").addEventListener("click", () => {
  historyPage.classList.remove("entering");
  adminPage.classList.remove("leaving");
});

async function renderHistoryView() {
  const contentEl = document.getElementById("history-view-content");
  contentEl.innerHTML = `<div class="panel">Loading...</div>`;
  try {
    const [log, clientGroups] = await Promise.all([
      apiGet("/_internal/client-history"),
      fetchClientGroups(),
    ]);
    const entries = log.entries || [];

    // "Removed" (a client literally disappearing from /plans) almost
    // never fires -- Flashproxy keeps cancelled/expired plans visible.
    // What actually happens is a client's plans all go inactive, which
    // the add/remove diff can't see. So this cross-references the
    // current real client list for anyone with zero active plans, in
    // addition to any literal "Removed" events that did fire.
    const removedNames = new Set(entries.filter((e) => e.event === "removed").map((e) => e.client));
    const inactiveGroups = clientGroups.filter((g) => !g.isActive);
    inactiveGroups.forEach((g) => removedNames.add(g.name));

    const inactivePanel = `
      <div class="panel">
        <div class="panel-title">Inactive / Removed Clients</div>
        <p class="graph-note">Clients with zero active plans right now, plus any that had a literal "Removed" event below. Flashproxy keeps cancelled/expired plans visible rather than deleting them, so most clients end up here instead of as a "Removed" event.</p>
        ${
          removedNames.size
            ? `<table class="data-table">
                <tr><th>Client</th><th>Status</th></tr>
                ${[...removedNames]
                  .map((name) => {
                    const group = clientGroups.find((g) => g.name === name);
                    return `<tr><td>${name}</td><td><span class="pill pill-pending">${group ? "Inactive" : "Removed"}</span></td></tr>`;
                  })
                  .join("")}
              </table>`
            : `<p>No inactive or removed clients.</p>`
        }
      </div>
    `;

    const eventLogPanel = !entries.length
      ? `<div class="panel"><div class="panel-title">Client History</div><p>No clients added or removed yet. New clients are recorded the next time the Plans tab loads.</p></div>`
      : `
        <div class="panel">
          <div class="panel-title">Every Client Added Or Removed</div>
          <p class="graph-note">Flashproxy's API has no add/remove event log of its own — a "client" here is an end_user_reference tag on a plan. This server watches every Plans fetch and records when a new one first appears, or a previously-seen one disappears. Newest first.</p>
          <table class="data-table">
            <tr><th>Time &amp; Date</th><th>Client</th><th>Event</th></tr>
            ${entries
              .map(
                (e) => `
              <tr>
                <td>${new Date(e.ts).toLocaleString()}</td>
                <td>${e.client}</td>
                <td><span class="pill ${e.event === "added" ? "pill-active" : "pill-pending"}">${e.event === "added" ? "Added" : "Removed"}</span></td>
              </tr>`
              )
              .join("")}
          </table>
        </div>
      `;

    contentEl.innerHTML = inactivePanel + eventLogPanel;
  } catch (err) {
    contentEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">Couldn't load this view</div>
        <p>${err.message}</p>
      </div>
    `;
  }
}

document.querySelectorAll(".admin-nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderAdminView(btn.dataset.adminView);
  });
});

const ADMIN_VIEW_TITLES = {
  users: "Users",
  "client-info": "Client Information",
  "reseller-info": "Reseller Information",
  "audit-log": "Audit Log",
};

let adminRenderToken = 0;

async function renderAdminView(view) {
  const myToken = ++adminRenderToken;
  const titleEl = document.getElementById("admin-view-title");
  const contentEl = document.getElementById("admin-view-content");
  titleEl.textContent = ADMIN_VIEW_TITLES[view];
  contentEl.innerHTML = `<div class="panel">Loading...</div>`;
  try {
    const html = await ADMIN_RENDERERS[view]();
    if (myToken !== adminRenderToken) return;
    contentEl.innerHTML = html;
    if (view === "users") setupUsersListFilter();
    if (view === "client-info") setupClientInfoFilter();
  } catch (err) {
    if (myToken !== adminRenderToken) return;
    contentEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">Couldn't load this view</div>
        <p>${err.message}</p>
      </div>
    `;
  }
}

let allClientGroups = [];

async function fetchClientGroups() {
  const plans = await apiGet("/plans?per_page=100");
  const groups = {};
  plans.plans.forEach((p) => {
    const key = p.end_user_reference || "Unassigned";
    if (!groups[key]) groups[key] = { name: key, plans: [] };
    groups[key].plans.push(p);
  });
  const list = Object.values(groups);

  await Promise.all(
    list.map(async (group) => {
      group.isActive = group.plans.some((p) => p.status === "active");
      group.bytesUsed = group.plans.reduce((sum, p) => sum + (p.limits?.bytes_used || 0), 0);
      group.maxBytes = group.plans.reduce((sum, p) => sum + (p.limits?.max_bytes || 0), 0);

      const metricsResults = await Promise.all(
        group.plans.slice(0, 5).map((p) =>
          apiGet(`/plans/${p.plan_id}/metrics/summary?hours=24`).catch(() => null)
        )
      );
      const validMetrics = metricsResults.filter(Boolean);
      group.avgMbps = validMetrics.length
        ? validMetrics.reduce((sum, m) => sum + m.avg_mbps, 0) / validMetrics.length
        : 0;
      group.peakMbps = validMetrics.length ? Math.max(...validMetrics.map((m) => m.peak_mbps)) : 0;
    })
  );

  return list;
}

function clientSlug(group) {
  return group.name.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

function clientCardHtml(group) {
  const bandwidthPct = group.maxBytes ? Math.min(100, (group.bytesUsed / group.maxBytes) * 100) : 0;
  const slug = clientSlug(group);
  const planIds = group.plans.slice(0, 5).map((p) => p.plan_id).join(",");
  return `
    <div class="panel">
      <div class="graph-header">
        <span class="panel-title">${group.name}</span>
        <span class="pill ${group.isActive ? "pill-active" : "pill-pending"}">${group.isActive ? "Active" : "Inactive"}</span>
      </div>
      <p class="graph-note">${group.plans.length} plan${group.plans.length === 1 ? "" : "s"}: ${group.plans.map((p) => p.product).join(", ")}</p>

      <div class="chart-axis-y-title">Bandwidth</div>
      <div class="graph-bar-track"><div class="graph-bar-fill" style="width:${bandwidthPct}%"></div></div>
      <div class="graph-value">${formatBytes(group.bytesUsed)} ${group.maxBytes ? `/ ${formatBytes(group.maxBytes)}` : ""}</div>

      <div class="graph-header" style="margin-top:16px;">
        <span class="chart-axis-y-title">Speed</span>
        <div class="range-toggle" data-client-speed-toggle="${slug}" data-plan-ids="${planIds}">
          ${RANGE_OPTIONS.map(
            (r) => `<button data-hours="${r.hours}" class="${r.hours === 24 ? "active" : ""}">${r.label}</button>`
          ).join("")}
        </div>
      </div>
      <div class="chart-axis-y-title">Speed (MBps)</div>
      <div id="client-speed-chart-${slug}">${buildLineChartSvg(24)}</div>
      <div class="chart-axis-x-title">Time</div>
      <div class="graph-value" id="client-speed-value-${slug}">${mbpsToMBps(group.avgMbps)} MBps <span class="graph-sub">peak ${mbpsToMBps(group.peakMbps)} MBps, over last 24h</span></div>
    </div>
  `;
}

function setupClientInfoFilter() {
  setupClientSpeedToggles();
  const toggle = document.querySelector('.range-toggle[data-client-filter="true"]');
  if (!toggle) return;
  const container = document.getElementById("client-cards-container");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      fadeSwap(container, () => {
        const filtered = filter === "active" ? allClientGroups.filter((g) => g.isActive) : allClientGroups;
        container.innerHTML = filtered.length
          ? filtered.map(clientCardHtml).join("")
          : `<div class="panel"><p>No clients in this filter.</p></div>`;
        setupClientSpeedToggles();
      });
    });
  });
}

function setupClientSpeedToggles() {
  document.querySelectorAll(".range-toggle[data-client-speed-toggle]").forEach((toggle) => {
    const slug = toggle.dataset.clientSpeedToggle;
    const planIds = toggle.dataset.planIds.split(",").filter(Boolean);
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const hours = btn.dataset.hours;
        document.getElementById(`client-speed-chart-${slug}`).innerHTML = buildLineChartSvg(hours);
        const valueEl = document.getElementById(`client-speed-value-${slug}`);
        try {
          const metricsResults = await Promise.all(
            planIds.map((id) => apiGet(`/plans/${id}/metrics/summary?hours=${hours}`).catch(() => null))
          );
          const valid = metricsResults.filter(Boolean);
          const avgMbps = valid.length ? valid.reduce((s, m) => s + m.avg_mbps, 0) / valid.length : 0;
          const peakMbps = valid.length ? Math.max(...valid.map((m) => m.peak_mbps)) : 0;
          valueEl.innerHTML = `${mbpsToMBps(avgMbps)} MBps <span class="graph-sub">peak ${mbpsToMBps(peakMbps)} MBps, over last ${hours}h</span>`;
        } catch (err) {
          valueEl.textContent = `Couldn't load this range: ${err.message}`;
        }
      });
    });
  });
}

function setupUsersListFilter() {
  const toggle = document.querySelector('.range-toggle[data-users-filter="true"]');
  if (!toggle) return;
  const container = document.getElementById("users-list-container");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      fadeSwap(container, () => {
        const filtered = filter === "active" ? allClientGroups.filter((g) => g.isActive) : allClientGroups;
        container.innerHTML = usersListTable(filtered);
      });
    });
  });
}

function usersListTable(groups) {
  if (!groups.length) return `<div class="panel"><p>No clients in this filter.</p></div>`;
  return `
    <div class="panel">
      <table class="data-table">
        <tr><th>Client</th><th>Status</th><th>Plans</th></tr>
        ${groups
          .map(
            (g) => `
          <tr>
            <td>${g.name}</td>
            <td><span class="pill ${g.isActive ? "pill-active" : "pill-pending"}">${g.isActive ? "Active" : "Inactive"}</span></td>
            <td>${g.plans.length}</td>
          </tr>`
          )
          .join("")}
      </table>
    </div>
  `;
}

const ADMIN_RENDERERS = {
  users: async () => {
    allClientGroups = await fetchClientGroups();
    allClientGroups.sort((a, b) => Number(b.isActive) - Number(a.isActive));
    return `
      <div class="graph-header" style="margin-bottom:16px;">
        <span class="panel-title">All clients using the proxy through this reseller</span>
        <div class="range-toggle" data-users-filter="true">
          <button data-filter="all" class="active">All Clients</button>
          <button data-filter="active">Active Clients</button>
        </div>
      </div>
      <div id="users-list-container">${usersListTable(allClientGroups)}</div>
    `;
  },

  "client-info": async () => {
    allClientGroups = await fetchClientGroups();
    return `
      <div class="graph-header" style="margin-bottom:16px;">
        <span class="panel-title">Clients using the proxy through this reseller</span>
        <div class="range-toggle" data-client-filter="true">
          <button data-filter="all" class="active">All Clients</button>
          <button data-filter="active">Active Clients</button>
        </div>
      </div>
      <div id="client-cards-container">
        ${allClientGroups.length ? allClientGroups.map(clientCardHtml).join("") : `<div class="panel"><p>No clients yet.</p></div>`}
      </div>
    `;
  },

  "reseller-info": async () => {
    const plans = await apiGet("/plans?per_page=100");
    const activePlans = plans.plans.filter((p) => p.status === "active");
    const otherPlans = plans.plans.filter((p) => p.status !== "active");
    return `
      <div class="panel">
        <div class="panel-title">Plans In Use Right Now</div>
        ${
          activePlans.length
            ? `<table class="data-table">
                <tr><th>Logged (Activated)</th><th>Product</th><th>Status</th><th>Expires</th></tr>
                ${activePlans
                  .map(
                    (p) => `
                  <tr>
                    <td>${new Date(p.activated_at || p.created_at).toLocaleString()}</td>
                    <td>${p.product}</td>
                    <td><span class="pill pill-active">${p.status}</span></td>
                    <td>${p.expires_at ? new Date(p.expires_at).toLocaleString() : "&mdash;"}</td>
                  </tr>`
                  )
                  .join("")}
              </table>`
            : `<p>No plans currently in use.</p>`
        }
      </div>
      <div class="panel">
        <div class="panel-title">Past Plans</div>
        ${
          otherPlans.length
            ? `<table class="data-table">
                <tr><th>Logged (Created)</th><th>Product</th><th>Status</th></tr>
                ${otherPlans
                  .map(
                    (p) => `
                  <tr>
                    <td>${new Date(p.created_at).toLocaleString()}</td>
                    <td>${p.product}</td>
                    <td><span class="pill pill-pending">${p.status}</span></td>
                  </tr>`
                  )
                  .join("")}
              </table>`
            : `<p>No expired or cancelled plans.</p>`
        }
      </div>
    `;
  },

  "audit-log": async () => {
    const log = await apiGet("/_internal/audit-log");
    const entries = log.entries || [];
    if (!entries.length) {
      return `<div class="panel"><div class="panel-title">Audit Log</div><p>No activity logged yet.</p></div>`;
    }
    return `
      <div class="panel">
        <div class="panel-title">Audit Log — Logins &amp; Actions</div>
        <p class="graph-note">Every request this server proxies to the Flashproxy API, across every key used on this dashboard. Newest first. Stored locally in <code>audit.log</code>, never sent anywhere else.</p>
        <table class="data-table">
          <tr><th>Time</th><th>Method</th><th>Endpoint</th><th>Key</th><th>Status</th></tr>
          ${entries
            .map(
              (e) => `
            <tr>
              <td>${new Date(e.ts).toLocaleString()}</td>
              <td>${e.method}</td>
              <td>${e.path}</td>
              <td><code>${e.key}</code></td>
              <td><span class="pill ${e.status >= 200 && e.status < 300 ? "pill-active" : "pill-pending"}">${e.status}</span></td>
            </tr>`
            )
            .join("")}
        </table>
      </div>
    `;
  },
};

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 8)}••••${key.slice(-4)}` : "••••";
}

// ---------------------------------------------------------------------
// Dashboard views -- every number below comes from a live fetch.
// ---------------------------------------------------------------------

document.querySelectorAll("#page-app .nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#page-app .nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderView(btn.dataset.view);
  });
});

const VIEW_TITLES = {
  overview: "Overview",
  balance: "Balance",
  plans: "Plans",
  "dedicated-isp": "Dedicated ISP",
  metrics: "Metrics",
  usage: "Usage",
};

let viewRenderToken = 0;

async function renderView(view) {
  const myToken = ++viewRenderToken;
  const titleEl = document.getElementById("view-title");
  const contentEl = document.getElementById("view-content");
  titleEl.textContent = VIEW_TITLES[view];

  // Stays faded out (opacity 0) through the loading state too -- fading
  // the black "Loading..." panel in and then immediately back out for
  // fast tabs was what showed up as a flashing black bar at the top.
  contentEl.style.opacity = "0";
  await new Promise((r) => setTimeout(r, 150));
  if (myToken !== viewRenderToken) return;

  const isUsageUncached = view === "usage" && !(usageCache.day && Date.now() - usageCache.day.ts < USAGE_CACHE_TTL_MS);
  contentEl.innerHTML = isUsageUncached
    ? `<div class="panel" style="color:#fff;">Loading... Flashproxy's usage endpoint runs a heavy aggregation and can take up to 30s.</div>`
    : `<div class="panel" style="color:#fff;">Loading...</div>`;
  try {
    const html = await RENDERERS[view]();
    // A slow tab (Usage, ~30s) can still be in flight when the user
    // switches to a faster tab. Without this check, whichever fetch
    // finishes LAST wins and overwrites the screen, regardless of
    // which tab is actually selected -- exactly the bug seen where the
    // nav/title said "Metrics" but the content was stale Usage HTML.
    if (myToken !== viewRenderToken) return;
    contentEl.innerHTML = html;
    contentEl.style.opacity = "1";
    if (view === "metrics") setupMetricsGraphs();
    if (view === "plans") {
      setupPlansFilter();
      setupPurchaseDropdown();
      setupBuyButtons();
    }
    if (view === "usage") setupUsageGraph();
  } catch (err) {
    if (myToken !== viewRenderToken) return;
    contentEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">Couldn't load this view</div>
        <p>${err.message}</p>
      </div>
    `;
    contentEl.style.opacity = "1";
  }
}

let currentMetricsPlanId = null;
let allFetchedPlans = [];

const RANGE_OPTIONS = [
  { label: "1hr", hours: 1 },
  { label: "3hr", hours: 3 },
  { label: "6hrs", hours: 6 },
  { label: "12hrs", hours: 12 },
  { label: "24hrs", hours: 24 },
];

const METRICS_SUPPORTED_PRODUCTS = ["datacenter", "shared_isp", "isp_eu", "ipv6-residential", "ipv6-datacenter"];

const MBPS_SCALE = 1000;
const CHART_W = 600;
const CHART_H = 140;
const CHART_PAD_L = 44;
const CHART_PAD_B = 24;

function buildLineChartSvg(hours) {
  const h = Number(hours);
  const plotW = CHART_W - CHART_PAD_L - 10;
  const plotH = CHART_H - CHART_PAD_B - 10;
  const baseY = 10 + plotH;
  // 1hr is the one range too short to show meaningfully in hours, so it
  // gets its own minute-based ticks (0-60m). Every other range keeps a
  // tick count that evenly divides it, otherwise rounding collapses
  // several x-axis labels onto the same value.
  const useMinutes = h === 1;
  const ticks = useMinutes ? 6 : Math.max(1, Math.min(6, h));
  const points = [];
  for (let i = 0; i <= ticks; i++) {
    const x = CHART_PAD_L + (plotW * i) / ticks;
    points.push(`${x},${baseY}`);
  }
  const yLabels = [60, 50, 40, 30, 20, 10, 0]
    .map((v, i) => {
      const y = 10 + (plotH * i) / 6;
      return `<text x="${CHART_PAD_L - 8}" y="${y + 4}" class="chart-axis-label" text-anchor="end">${v}</text>`;
    })
    .join("");
  const xLabels = points
    .map((pt, i) => {
      const x = pt.split(",")[0];
      const label = useMinutes ? `${(60 * i) / ticks}m` : `${(h * i) / ticks}h`;
      return `<text x="${x}" y="${CHART_H - 6}" class="chart-axis-label" text-anchor="middle">${label}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" preserveAspectRatio="none">
      <line x1="${CHART_PAD_L}" y1="10" x2="${CHART_PAD_L}" y2="${baseY}" class="chart-axis-line" />
      <line x1="${CHART_PAD_L}" y1="${baseY}" x2="${CHART_W - 10}" y2="${baseY}" class="chart-axis-line" />
      <polyline points="${points.join(" ")}" class="chart-line" />
      ${yLabels}
      ${xLabels}
    </svg>
  `;
}

function mbpsToMBps(mbps) {
  return (mbps / 8).toFixed(2);
}

// Fades `el` out, runs `applyFn` (sync or async) to swap its content,
// then fades back in. Used on every toggle (All/Active, time-range
// buttons) so switching feels deliberate instead of an instant snap --
// and because applyFn runs inside a try/catch, a failed fetch mid-toggle
// shows a real error instead of silently leaving stale/blank content.
async function fadeSwap(el, applyFn) {
  if (!el) return;
  el.style.transition = "opacity 0.3s ease";
  el.style.opacity = "0";
  await new Promise((r) => setTimeout(r, 300));
  try {
    await applyFn();
  } catch (err) {
    el.innerHTML = `<div class="panel"><div class="panel-title">Couldn't load this</div><p>${err.message}</p></div>`;
  }
  el.style.opacity = "1";
}

function metricGraph(key, title, mbps, hours) {
  return `
    <div class="panel panel-graph">
      <div class="graph-header">
        <span class="panel-title">${title}</span>
        <div class="range-toggle" data-metric="${key}">
          ${RANGE_OPTIONS.map(
            (r) => `<button data-hours="${r.hours}" class="${r.hours === hours ? "active" : ""}">${r.label}</button>`
          ).join("")}
        </div>
      </div>
      <div class="chart-axis-y-title">Speed (MBps)</div>
      <div id="chart-${key}">${buildLineChartSvg(hours)}</div>
      <div class="chart-axis-x-title">Time</div>
      <p class="graph-note">Flashproxy's API has no per-interval history endpoint, only one aggregate value per window — real current average is ${mbpsToMBps(mbps)} MBps over the last ${hours}h, plotted at 0 above since no minute-by-minute data exists to chart.</p>
    </div>
  `;
}

const USAGE_PERIODS = [
  { label: "Hour", value: "hour" },
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
];

// Flashproxy's /usage/summary runs a heavy server-side aggregation and
// regularly takes ~30s to respond (confirmed by timing the real upstream
// API directly, not just our proxy) -- nothing to optimize client-side.
// This cache just avoids re-paying that 30s every time you revisit the
// tab or flip back to a period you already loaded this session.
const usageCache = {};
const USAGE_CACHE_TTL_MS = 60000;

async function getUsageCached(period) {
  const cached = usageCache[period];
  if (cached && Date.now() - cached.ts < USAGE_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await apiGet(`/usage/summary?period=${period}`);
  usageCache[period] = { data, ts: Date.now() };
  return data;
}

function usagePeriodTicks(period) {
  switch (period) {
    case "hour":
      return [0, 10, 20, 30, 40, 50, 60].map((v) => `${v}m`);
    case "day":
      return [0, 4, 8, 12, 16, 20, 24].map((v) => `${v}h`);
    case "week":
      return [0, 1, 2, 3, 4, 5, 6, 7].map((v) => `d${v}`);
    case "month":
    default:
      return [0, 5, 10, 15, 20, 25, 30].map((v) => `d${v}`);
  }
}

function buildUsageChartSvg(period, points) {
  const plotW = CHART_W - CHART_PAD_L - 10;
  const plotH = CHART_H - CHART_PAD_B - 10;
  const baseY = 10 + plotH;
  const n = points.length - 1;
  const coords = points.map((_, i) => {
    const x = CHART_PAD_L + (plotW * i) / n;
    return `${x},${baseY}`;
  });
  const yLabels = ["1 GB", "0.75 GB", "0.5 GB", "0.25 GB", "0 GB"]
    .map((label, i) => {
      const y = 10 + (plotH * i) / 4;
      return `<text x="${CHART_PAD_L - 8}" y="${y + 4}" class="chart-axis-label" text-anchor="end">${label}</text>`;
    })
    .join("");
  const xLabels = points
    .map((label, i) => {
      const x = CHART_PAD_L + (plotW * i) / n;
      return `<text x="${x}" y="${CHART_H - 6}" class="chart-axis-label" text-anchor="middle">${label}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" preserveAspectRatio="none">
      <line x1="${CHART_PAD_L}" y1="10" x2="${CHART_PAD_L}" y2="${baseY}" class="chart-axis-line" />
      <line x1="${CHART_PAD_L}" y1="${baseY}" x2="${CHART_W - 10}" y2="${baseY}" class="chart-axis-line" />
      <polyline points="${coords.join(" ")}" class="chart-line" />
      ${yLabels}
      ${xLabels}
    </svg>
  `;
}

function usageGraph(usage) {
  const period = usage.time_range?.period || "day";
  const totalGb = usage.summary?.total_gb ?? 0;
  return `
    <div class="panel panel-graph">
      <div class="graph-header">
        <span class="panel-title">Data Used</span>
        <div class="range-toggle" data-usage-toggle="true">
          ${USAGE_PERIODS.map(
            (p) => `<button data-period="${p.value}" class="${p.value === period ? "active" : ""}">${p.label}</button>`
          ).join("")}
        </div>
      </div>
      <div class="chart-axis-y-title">Data Used (GB)</div>
      <div id="usage-chart">${buildUsageChartSvg(period, usagePeriodTicks(period))}</div>
      <div class="chart-axis-x-title">Time</div>
      <p class="graph-note" id="usage-graph-note">Flashproxy's API returns a single total for the chosen period (no per-interval breakdown for this account yet), so the line is plotted at 0 — real total used over the last ${period} is ${totalGb} GB.</p>
    </div>
  `;
}

function setupUsageGraph() {
  const toggle = document.querySelector('.range-toggle[data-usage-toggle="true"]');
  if (!toggle) return;
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const period = btn.dataset.period;
      document.getElementById("usage-chart").innerHTML = buildUsageChartSvg(period, usagePeriodTicks(period));
      const noteEl = document.getElementById("usage-graph-note");
      const isCached = usageCache[period] && Date.now() - usageCache[period].ts < USAGE_CACHE_TTL_MS;
      if (!isCached) {
        noteEl.textContent = "Loading... Flashproxy's usage endpoint runs a heavy aggregation and can take up to 30s.";
      }
      try {
        const usage = await getUsageCached(period);
        const totalGb = usage.summary?.total_gb ?? 0;
        noteEl.textContent = `Flashproxy's API returns a single total for the chosen period (no per-interval breakdown for this account yet), so the line is plotted at 0 — real total used over the last ${period} is ${totalGb} GB.`;
      } catch (err) {
        noteEl.textContent = `Couldn't load this period: ${err.message}`;
      }
    });
  });
}

// Animates scrollTop by `delta` over `duration`ms with the same easing
// curve as the height animation below, so the page scroll and the
// dropdown's expansion visibly move together instead of the scroll
// happening separately (instant jump or a differently-timed native
// smooth-scroll).
function animateScrollBy(container, delta, duration) {
  const start = container.scrollTop;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 2); // ease-out, matches CSS "ease" closely enough
    container.scrollTop = start + delta * eased;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setupPurchaseDropdown() {
  const wrapper = document.getElementById("purchase-dropdown");
  const summary = document.getElementById("purchase-summary");
  const content = document.getElementById("purchase-content");
  if (!wrapper || !summary || !content) return;
  const scrollContainer = wrapper.closest(".app-main") || document.scrollingElement;

  content.style.height = "0px";
  content.style.overflow = "hidden";
  let isOpen = false;
  const ANIM_DURATION = 500;

  summary.addEventListener("click", () => {
    const targetHeight = content.scrollHeight;
    if (!isOpen) {
      content.animate(
        [{ height: "0px" }, { height: `${targetHeight}px` }],
        { duration: ANIM_DURATION, easing: "ease" }
      ).onfinish = () => {
        content.style.height = "auto";
      };
      content.style.height = `${targetHeight}px`;
      wrapper.classList.add("open");
      animateScrollBy(scrollContainer, targetHeight, ANIM_DURATION);
    } else {
      content.style.height = `${targetHeight}px`;
      content.animate(
        [{ height: `${targetHeight}px` }, { height: "0px" }],
        { duration: ANIM_DURATION, easing: "ease" }
      ).onfinish = () => {
        content.style.height = "0px";
      };
      wrapper.classList.remove("open");
      animateScrollBy(scrollContainer, -targetHeight, ANIM_DURATION);
    }
    isOpen = !isOpen;
  });
}

const BANDWIDTH_ONLY_PRODUCTS = ["residential", "residential-lite", "mobile", "pool1", "pool2", "pool3", "pool4", "pool5"];
const HYBRID_PRODUCTS = ["datacenter", "shared_isp", "isp_eu", "ipv6-residential", "ipv6-datacenter"];

// Builds a real CreatePlanRequest body. Bandwidth/hybrid products need a
// GB amount from the user; dedicated_isp needs a pool + quantity;
// unlimited_residential has no per-purchase input here, so it always
// buys the cheapest valid option (a trial) rather than guessing a
// duration/Mbps combo. Returns null if the user cancels the prompt.
async function buildPurchasePayload(product) {
  if (BANDWIDTH_ONLY_PRODUCTS.includes(product)) {
    const gb = Number(window.prompt(`How many GB of ${product} do you want to buy?`, "1"));
    if (!gb || gb <= 0) return null;
    return { product, bandwidth_gb: gb };
  }
  if (HYBRID_PRODUCTS.includes(product)) {
    const gb = Number(window.prompt(`How many GB of ${product} do you want to buy? (billed per GB)`, "1"));
    if (!gb || gb <= 0) return null;
    return { product, billing_type: "bandwidth", bandwidth_gb: gb };
  }
  if (product === "dedicated_isp") {
    const pools = await apiGet("/proxies/pools").catch(() => null);
    const bestPool = pools?.pools?.filter((p) => p.inStock).sort((a, b) => b.stock - a.stock)[0];
    if (!bestPool) {
      window.alert("No dedicated ISP pools currently in stock.");
      return null;
    }
    const quantity = Number(window.prompt(`How many IPs from pool "${bestPool.pool}" (${bestPool.stock} in stock)?`, "1"));
    if (!quantity || quantity <= 0) return null;
    if (quantity > bestPool.stock) {
      window.alert(`Only ${bestPool.stock} IPs in stock in that pool.`);
      return null;
    }
    return { product, quantity, pool: bestPool.pool };
  }
  if (product === "unlimited_residential") {
    if (!window.confirm("unlimited_residential has no fixed per-purchase amount here, so this buys a 1-hour/200Mbps trial instead. Continue?")) {
      return null;
    }
    return { product, duration: "trial" };
  }
  window.alert(`Don't know how to buy "${product}" yet.`);
  return null;
}

function setupBuyButtons() {
  document.querySelectorAll("[data-buy-product]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const product = btn.dataset.buyProduct;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const payload = await buildPurchasePayload(product);
        if (!payload) return;

        const priceCheck = await apiPost("/plans/check-price", payload);
        if (priceCheck.status !== 200 || !priceCheck.json?.success) {
          window.alert(priceCheck.json?.error?.message || "Couldn't check the price for that purchase.");
          return;
        }
        const cost = priceCheck.json.data.cost_usd;
        if (!window.confirm(`This will charge $${cost} to your real Flashproxy balance. Buy ${product} now?`)) {
          return;
        }

        const idempotencyKey = crypto.randomUUID();
        const purchase = await apiPost("/plans", payload, idempotencyKey);

        if (purchase.status === 201 && purchase.json?.success) {
          const plan = purchase.json.data;
          window.alert(`Purchased. Connection: ${plan.connection?.format ?? "see Plans tab"}\nCost: ${plan.billing?.cost_formatted ?? `$${cost}`}`);
          renderView("plans");
        } else if (purchase.status === 402) {
          window.alert(`Insufficient balance: ${purchase.json?.error?.message ?? "not enough balance for this purchase."}\nOpening flashproxy.com so you can top up.`);
          window.open("https://www.flashproxy.com/dashboard", "_blank");
        } else {
          window.alert(purchase.json?.error?.message || `Purchase failed (${purchase.status}).`);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

function setupPlansFilter() {
  const toggle = document.querySelector('.range-toggle[data-plans-filter="true"]');
  if (!toggle) return;
  const container = document.getElementById("plans-table-container");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      fadeSwap(container, () => {
        const filtered = filter === "active" ? allFetchedPlans.filter((p) => p.status === "active") : allFetchedPlans;
        container.innerHTML = plansTable(filtered);
      });
    });
  });
}

function setupMetricsGraphs() {
  document.querySelectorAll(".range-toggle[data-metric]").forEach((toggle) => {
    const key = toggle.dataset.metric;
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!currentMetricsPlanId) return;
        toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const hours = btn.dataset.hours;
        const chartEl = document.getElementById(`chart-${key}`);
        const panel = chartEl.closest(".panel-graph");
        chartEl.innerHTML = buildLineChartSvg(hours);
        try {
          const m = await apiGet(`/plans/${currentMetricsPlanId}/metrics/summary?hours=${hours}`);
          const mbps = key === "avg" ? m.avg_mbps : m.peak_mbps;
          panel.querySelector(".graph-note").textContent = `Flashproxy's API has no per-interval history endpoint, only one aggregate value per window — real current average is ${mbpsToMBps(mbps)} MBps over the last ${hours}h, plotted at 0 above since no minute-by-minute data exists to chart.`;
        } catch (err) {
          panel.querySelector(".graph-note").textContent = `Couldn't load this range: ${err.message}`;
        }
      });
    });
  });
}

const RENDERERS = {
  overview: async () => {
    const [balance, plans] = await Promise.all([
      apiGet("/balance"),
      apiGet("/plans?per_page=100"),
    ]);
    const activePlanList = plans.plans.filter((p) => p.status === "active");
    return `
      <div class="cards-grid">
        ${statCard("Current Balance", balance.balance_formatted, "Available to spend", "stat-card-purple")}
        ${statCard("Current Active Plans", activePlanList.length, "Across all products", "stat-card-purple")}
      </div>
      <div class="panel">
        <div class="panel-title">Recent Plans</div>
        ${plansTable(plans.plans.slice(0, 5))}
      </div>
      <div class="panel">
        <div class="panel-title panel-title-light-purple">Proxies Currently Used By Clients</div>
        ${
          activePlanList.length
            ? `<table class="data-table">
                <tr><th>Client Reference</th><th>Product</th><th>Proxy Address</th><th>Allowed IPs</th><th>Expires</th></tr>
                ${activePlanList
                  .map(
                    (p) => `
                  <tr>
                    <td class="td-light-purple">${p.end_user_reference || "&mdash;"}</td>
                    <td>${p.product}</td>
                    <td class="td-light-purple">${p.connection?.format ?? "&mdash;"}</td>
                    <td>${p.allowed_ips?.length ? p.allowed_ips.join(", ") : "Any"}</td>
                    <td>${p.expires_at ? new Date(p.expires_at).toLocaleDateString() : "&mdash;"}</td>
                  </tr>`
                  )
                  .join("")}
              </table>`
            : `<p>No proxies currently lent to clients.</p>`
        }
      </div>
    `;
  },

  balance: async () => {
    const [balance, transactions, pricing] = await Promise.all([
      apiGet("/balance"),
      apiGet("/balance/transactions?per_page=10"),
      apiGet("/balance/pricing"),
    ]);
    const allocationCards = Object.entries(balance.allocations || {})
      .filter(([, alloc]) => alloc)
      .map(([product, alloc]) =>
        statCard(product, `${alloc.remaining_gb ?? alloc.gb_remaining ?? 0} GB`, "Pre-paid, remaining")
      )
      .join("");
    return `
      <div class="cards-grid">
        ${statCard("Balance", balance.balance_formatted, "Available to spend", "stat-card-purple")}
        ${statCard("Total Spent", balance.total_spent_formatted, "Lifetime", "stat-card-purple")}
        ${allocationCards}
      </div>
      <div class="panel panel-white">
        <div class="panel-title panel-title-dark">Top Up Balance</div>
        <div class="topup-options">
          <a class="topup-button" href="https://www.flashproxy.com" target="_blank" rel="noopener">Visa</a>
          <a class="topup-button" href="https://www.flashproxy.com" target="_blank" rel="noopener">Mastercard</a>
          <a class="topup-button" href="https://www.flashproxy.com" target="_blank" rel="noopener">Bitcoin</a>
        </div>
        <p class="topup-note">Opens flashproxy.com to complete your top-up — payments aren't processed in this dashboard.</p>
      </div>
      <div class="panel">
        <div class="panel-title">Transaction History</div>
        ${transactionsTable(transactions.items)}
      </div>
      <div class="panel">
        <div class="panel-title">Your Pricing</div>
        <table class="data-table">
          <tr><th>Product</th><th>Type</th><th>Price</th></tr>
          ${Object.entries(pricing.products || {})
            .map(([product, p]) => `<tr><td>${product}</td><td>${p.type}</td><td>${pricingCell(p, pricing.currency)}</td></tr>`)
            .join("")}
        </table>
      </div>
    `;
  },

  plans: async () => {
    const [plans, pricing] = await Promise.all([
      apiGet("/plans?per_page=100"),
      apiGet("/balance/pricing"),
    ]);
    const counts = {};
    plans.plans.forEach((p) => {
      counts[p.product] = (counts[p.product] || 0) + 1;
    });
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [topProduct, topCount] = ranked[0] || ["&mdash;", 0];
    const products = Object.entries(pricing.products || {});
    allFetchedPlans = plans.plans;
    return `
      <div class="panel">
        <div class="graph-header">
          <span class="panel-title">All Plans</span>
          <div class="range-toggle" data-plans-filter="true">
            <button data-filter="all" class="active">All Plans</button>
            <button data-filter="active">Active</button>
          </div>
        </div>
        <div id="plans-table-container">${plansTable(plans.plans)}</div>
      </div>
      <div class="panel panel-white">
        <div class="panel-title panel-title-dark">Most Purchased Plan</div>
        <div class="cards-grid">
          ${statCard("Top Product", topProduct, `Purchased ${topCount} time${topCount === 1 ? "" : "s"}`, "stat-card-purple")}
        </div>
        <table class="data-table">
          <tr><th>Product</th><th>Purchase Frequency</th></tr>
          ${ranked.map(([product, count]) => `<tr><td>${product}</td><td>${count}</td></tr>`).join("")}
        </table>
      </div>
      <div class="panel panel-darkpurple purchase-dropdown" id="purchase-dropdown">
        <div class="purchase-summary" id="purchase-summary">
          <span class="panel-title">Purchase More Options</span>
          <span class="purchase-caret">▾</span>
        </div>
        <div class="purchase-content" id="purchase-content">
          <div class="table-scroll">
            <table class="data-table">
              <tr><th>Product</th><th>Type</th><th>Price</th><th></th></tr>
              ${products
                .map(([product, p]) => `
                  <tr>
                    <td>${product}</td>
                    <td>${p.type}</td>
                    <td>${pricingCell(p, pricing.currency)}</td>
                    <td><button class="topup-button buy-button-orange" data-buy-product="${product}">Buy</button></td>
                  </tr>`)
                .join("")}
            </table>
          </div>
          <p class="topup-note topup-note-dark">Pricing pulled live from your account. Flashproxy's Reseller API has no checkout/purchase endpoint, so "Buy" opens the real purchase flow on flashproxy.com instead of faking a transaction here.</p>
        </div>
      </div>
    `;
  },

  "dedicated-isp": async () => {
    const pools = await apiGet("/proxies/pools");
    return `
      <div class="panel">
        <div class="panel-title">Available ISP Pools</div>
        <table class="data-table">
          <tr><th>Pool</th><th>Title</th><th>Stock</th><th>Status</th></tr>
          ${pools.pools
            .map(
              (p) => `
            <tr>
              <td>${p.pool}</td>
              <td>${p.title}</td>
              <td>${p.stock}</td>
              <td><span class="pill pill-stock">${p.inStock ? "In stock" : "Out of stock"}</span></td>
            </tr>`
            )
            .join("")}
        </table>
      </div>
    `;
  },

  metrics: async () => {
    // Flashproxy only supports the metrics endpoint for datacenter,
    // shared_isp, isp_eu, ipv6-residential, and ipv6-datacenter plans --
    // every other product 400s with METRICS_NOT_SUPPORTED. Picking just
    // the newest plan (regardless of product) was the bug: a newer
    // residential/mobile/etc plan would always 400 here.
    const plans = await apiGet("/plans?per_page=100");
    const metricsSupportedPlan = plans.plans.find(
      (p) => p.status === "active" && METRICS_SUPPORTED_PRODUCTS.includes(p.product)
    );
    const planId = metricsSupportedPlan?.plan_id;
    if (!planId) {
      return `<div class="panel"><div class="panel-title">Metrics</div><p>No active plan on this account supports metrics. Flashproxy only exposes metrics for datacenter, shared_isp, isp_eu, ipv6-residential, and ipv6-datacenter plans.</p></div>`;
    }
    currentMetricsPlanId = planId;
    const m = await apiGet(`/plans/${planId}/metrics/summary?hours=24`);
    return `
      <div class="cards-grid">
        ${statCard("Success Rate", `${m.success_rate_pct ?? "&mdash;"}%`, `${m.total_successes}/${m.total_connections} connections`)}
        ${statCard("Peak Concurrent", m.peak_concurrent, "Simultaneous connections")}
      </div>
      ${metricGraph("avg", "Throughput (avg)", m.avg_mbps, m.hours)}
      ${metricGraph("peak", "Throughput (peak)", m.peak_mbps, m.hours)}
      <div class="panel">
        <div class="panel-title">Traffic Summary</div>
        <table class="data-table">
          <tr><th>Metric</th><th>Value</th></tr>
          <tr><td>Total transferred</td><td>${m.total_mb} MB</td></tr>
          <tr><td>Connections</td><td>${m.total_connections}</td></tr>
          <tr><td>Errors</td><td>${m.total_errors}</td></tr>
          <tr><td>Burst (1s peak)</td><td>${m.burst_mbps} Mbps</td></tr>
        </table>
      </div>
    `;
  },


  usage: async () => {
    const usage = await getUsageCached("day");
    return `
      <div class="cards-grid">${statCard("Total Bandwidth", formatBytes(usage.summary?.total_bytes), `This ${usage.time_range?.period}`)}</div>
      ${usageGraph(usage)}
      <div class="panel">
        <div class="panel-title">By Product</div>
        <table class="data-table">
          <tr><th>Product</th><th>Used</th><th>Plans</th></tr>
          ${Object.entries(usage.by_product || {})
            .map(([product, p]) => `<tr><td>${product}</td><td>${formatBytes(p.bytes)}</td><td>${p.plans}</td></tr>`)
            .join("")}
        </table>
      </div>
    `;
  },
};

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

function statCard(label, value, sub, variant = "") {
  return `
    <div class="stat-card ${variant}">
      <div class="stat-card-label">${label}</div>
      <div class="stat-card-value">${value}</div>
      <div class="stat-card-sub">${sub}</div>
    </div>
  `;
}

function transactionsTable(items) {
  if (!items || !items.length) return `<p>No transactions yet.</p>`;
  return `
    <table class="data-table">
      <tr><th>ID</th><th>Type</th><th>Amount</th><th>Description</th><th>Date</th></tr>
      ${items
        .map(
          (t) => `
        <tr>
          <td>${t.id}</td>
          <td>${t.type}</td>
          <td>${t.amount_formatted}</td>
          <td>${t.description}</td>
          <td>${new Date(t.created_at).toLocaleDateString()}</td>
        </tr>`
        )
        .join("")}
    </table>
  `;
}

function pricingCell(p, currency = "USD") {
  const parts = [];
  if (p.price_per_gb != null) parts.push(`$${p.price_per_gb}/GB`);
  if (p.price_per_ip_30_days != null) parts.push(`$${p.price_per_ip_30_days}/IP/30d`);
  if (p.bandwidth?.price_per_gb != null) parts.push(`$${p.bandwidth.price_per_gb}/GB`);
  if (p.time?.price_per_mbps_per_day != null) parts.push(`$${p.time.price_per_mbps_per_day}/Mbps/day`);
  return parts.length ? `${parts.join(" or ")} ${currency}` : "&mdash;";
}

function plansTable(items) {
  if (!items.length) return `<p>No plans yet.</p>`;
  return `
    <table class="data-table">
      <tr><th>Plan ID</th><th>Product</th><th>Usage</th><th>Status</th><th>Expires</th></tr>
      ${items
        .map((p) => {
          const limits = p.limits || {};
          const usedGb = limits.bytes_used != null ? limits.bytes_used / 1e9 : null;
          const maxGb = limits.max_gb;
          let usageCell = "&mdash;";
          if (maxGb && usedGb != null) {
            const pct = Math.min(100, (usedGb / maxGb) * 100);
            usageCell = `${usedGb.toFixed(2)} / ${maxGb} GB<div class="bandwidth-bar"><div class="bandwidth-bar-fill" style="width:${pct}%"></div></div>`;
          } else if (usedGb != null) {
            usageCell = `${usedGb.toFixed(2)} GB used`;
          }
          const statusPill = p.status === "active" ? "pill-active" : "pill-pending";
          const expires = p.expires_at ? new Date(p.expires_at).toLocaleDateString() : "&mdash;";
          return `
            <tr>
              <td>${p.plan_id}</td>
              <td>${p.product}</td>
              <td>${usageCell}</td>
              <td><span class="pill ${statusPill}">${p.status}</span></td>
              <td>${expires}</td>
            </tr>`;
        })
        .join("")}
    </table>
  `;
}
