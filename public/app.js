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
    const log = await apiGet("/_internal/client-history");
    const entries = log.entries || [];
    contentEl.innerHTML = !entries.length
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

async function renderAdminView(view) {
  const titleEl = document.getElementById("admin-view-title");
  const contentEl = document.getElementById("admin-view-content");
  titleEl.textContent = ADMIN_VIEW_TITLES[view];
  contentEl.innerHTML = `<div class="panel">Loading...</div>`;
  try {
    contentEl.innerHTML = await ADMIN_RENDERERS[view]();
    if (view === "users") setupUsersListFilter();
    if (view === "client-info") setupClientInfoFilter();
  } catch (err) {
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
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      const filtered = filter === "active" ? allClientGroups.filter((g) => g.isActive) : allClientGroups;
      document.getElementById("client-cards-container").innerHTML = filtered.length
        ? filtered.map(clientCardHtml).join("")
        : `<div class="panel"><p>No clients in this filter.</p></div>`;
      setupClientSpeedToggles();
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
        const metricsResults = await Promise.all(
          planIds.map((id) => apiGet(`/plans/${id}/metrics/summary?hours=${hours}`).catch(() => null))
        );
        const valid = metricsResults.filter(Boolean);
        const avgMbps = valid.length ? valid.reduce((s, m) => s + m.avg_mbps, 0) / valid.length : 0;
        const peakMbps = valid.length ? Math.max(...valid.map((m) => m.peak_mbps)) : 0;
        document.getElementById(`client-speed-value-${slug}`).innerHTML = `${mbpsToMBps(avgMbps)} MBps <span class="graph-sub">peak ${mbpsToMBps(peakMbps)} MBps, over last ${hours}h</span>`;
      });
    });
  });
}

function setupUsersListFilter() {
  const toggle = document.querySelector('.range-toggle[data-users-filter="true"]');
  if (!toggle) return;
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      const filtered = filter === "active" ? allClientGroups.filter((g) => g.isActive) : allClientGroups;
      document.getElementById("users-list-container").innerHTML = usersListTable(filtered);
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
  "sub-users": "Sub-Users",
  usage: "Usage",
};

async function renderView(view) {
  const titleEl = document.getElementById("view-title");
  const contentEl = document.getElementById("view-content");
  titleEl.textContent = VIEW_TITLES[view];
  contentEl.innerHTML = `<div class="panel">Loading...</div>`;
  try {
    contentEl.innerHTML = await RENDERERS[view]();
    if (view === "overview") setupClientProxyDropdown();
    if (view === "metrics") setupMetricsGraphs();
    if (view === "plans") setupPlansFilter();
    if (view === "usage") setupUsageGraph();
  } catch (err) {
    contentEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">Couldn't load this view</div>
        <p>${err.message}</p>
      </div>
    `;
  }
}

let activeClientPlans = [];
let currentMetricsPlanId = null;
let allFetchedPlans = [];

const RANGE_OPTIONS = [
  { label: "1hr", hours: 1 },
  { label: "3hr", hours: 3 },
  { label: "6hrs", hours: 6 },
  { label: "12hrs", hours: 12 },
  { label: "24hrs", hours: 24 },
];

const MBPS_SCALE = 1000;
const CHART_W = 600;
const CHART_H = 140;
const CHART_PAD_L = 44;
const CHART_PAD_B = 24;

function buildLineChartSvg(hours) {
  const plotW = CHART_W - CHART_PAD_L - 10;
  const plotH = CHART_H - CHART_PAD_B - 10;
  const baseY = 10 + plotH;
  const ticks = 6;
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
      const labelHours = Math.round((hours * i) / ticks);
      return `<text x="${x}" y="${CHART_H - 6}" class="chart-axis-label" text-anchor="middle">${labelHours}h</text>`;
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
      const usage = await apiGet(`/usage/summary?period=${period}`);
      const totalGb = usage.summary?.total_gb ?? 0;
      document.getElementById("usage-graph-note").textContent = `Flashproxy's API returns a single total for the chosen period (no per-interval breakdown for this account yet), so the line is plotted at 0 — real total used over the last ${period} is ${totalGb} GB.`;
    });
  });
}

function setupPlansFilter() {
  const toggle = document.querySelector('.range-toggle[data-plans-filter="true"]');
  if (!toggle) return;
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      const filtered = filter === "active" ? allFetchedPlans.filter((p) => p.status === "active") : allFetchedPlans;
      document.getElementById("plans-table-container").innerHTML = plansTable(filtered);
    });
  });
}

function setupMetricsGraphs() {
  document.querySelectorAll(".range-toggle").forEach((toggle) => {
    const key = toggle.dataset.metric;
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!currentMetricsPlanId) return;
        toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const hours = btn.dataset.hours;
        document.getElementById(`chart-${key}`).innerHTML = buildLineChartSvg(hours);
        const m = await apiGet(`/plans/${currentMetricsPlanId}/metrics/summary?hours=${hours}`);
        const mbps = key === "avg" ? m.avg_mbps : m.peak_mbps;
        const noteEl = document.getElementById(`chart-${key}`).closest(".panel-graph").querySelector(".graph-note");
        noteEl.textContent = `Flashproxy's API has no per-interval history endpoint, only one aggregate value per window — real current average is ${mbpsToMBps(mbps)} MBps over the last ${hours}h, plotted at 0 above since no minute-by-minute data exists to chart.`;
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
    activeClientPlans = activePlanList;
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
            ? `<select id="client-proxy-select" class="dropdown-select">
                ${activePlanList
                  .map(
                    (p, i) =>
                      `<option value="${i}">${p.end_user_reference || p.plan_id.slice(0, 8)} — ${p.product}</option>`
                  )
                  .join("")}
              </select>
              <div id="client-proxy-details"></div>`
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
    const products = Object.keys(pricing.products || {});
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
      <details class="panel panel-darkpurple purchase-dropdown">
        <summary class="panel-title">Purchase More Options</summary>
        <div class="purchase-options">
          ${products
            .map(
              (product) =>
                `<a class="topup-button topup-button-dark" href="https://www.flashproxy.com/dashboard" target="_blank" rel="noopener">${product}</a>`
            )
            .join("")}
        </div>
        <p class="topup-note topup-note-dark">Opens flashproxy.com to complete your purchase — purchases aren't processed in this dashboard.</p>
      </details>
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
    const plans = await apiGet("/plans?per_page=1");
    const planId = plans.plans[0]?.plan_id;
    if (!planId) {
      return `<div class="panel"><div class="panel-title">Metrics</div><p>No plans on this account yet.</p></div>`;
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

  "sub-users": async () => {
    const subUsers = await apiGet("/sub-users");
    const items = subUsers.sub_users || [];
    if (!items.length) {
      return `<div class="panel"><div class="panel-title">Sub-Users</div><p>No sub-users yet.</p></div>`;
    }
    return items
      .map(
        (u, i) => `
      <div class="panel">
        <div class="panel-title">Sub User ${i + 1}</div>
        <div class="cards-grid">
          ${statCard("Name", u.name ?? "&mdash;", u.email ?? "&mdash;")}
          ${statCard("Balance", `$${((u.balance_cents ?? 0) / 100).toFixed(2)}`, "Current balance")}
          ${statCard("Plans", u.plans_count ?? 0, "Active + past plans")}
        </div>
        <table class="data-table">
          <tr><th>Status</th><td><span class="pill pill-active">${u.status ?? "&mdash;"}</span></td></tr>
          <tr><th>Joined</th><td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : "&mdash;"}</td></tr>
        </table>
        <p class="graph-note">FlashProxy's Sub-Users API doesn't link a sub-user to specific plans, so per-plan data usage, billing rate, and speed can't be attributed to this client — only the fields above are available.</p>
      </div>
    `
      )
      .join("");
  },

  usage: async () => {
    const usage = await apiGet("/usage/summary?period=day");
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

function setupClientProxyDropdown() {
  const select = document.getElementById("client-proxy-select");
  if (!select) return;
  const renderDetails = () => {
    const plan = activeClientPlans[select.value];
    const detailsEl = document.getElementById("client-proxy-details");
    if (!plan || !detailsEl) return;
    detailsEl.innerHTML = `
      <table class="data-table">
        <tr><th>Client Reference</th><td class="td-light-purple">${plan.end_user_reference || "&mdash;"}</td></tr>
        <tr><th>Product</th><td>${plan.product}</td></tr>
        <tr><th>Proxy Address</th><td class="td-light-purple">${plan.connection?.format ?? "&mdash;"}</td></tr>
        <tr><th>Allowed IPs</th><td>${plan.allowed_ips?.length ? plan.allowed_ips.join(", ") : "Any"}</td></tr>
        <tr><th>Expires</th><td>${plan.expires_at ? new Date(plan.expires_at).toLocaleDateString() : "&mdash;"}</td></tr>
      </table>
    `;
  };
  select.addEventListener("change", renderDetails);
  renderDetails();
}

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
