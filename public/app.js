let currentApiKey = null;

const welcomePage = document.getElementById("page-welcome");
const loginPage = document.getElementById("page-login");
const appPage = document.getElementById("page-app");

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
revealLetters(document.querySelector("#page-login .hero-title"), 0.045, 0.1);

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
});

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 8)}••••${key.slice(-4)}` : "••••";
}

// ---------------------------------------------------------------------
// Dashboard views -- every number below comes from a live fetch.
// ---------------------------------------------------------------------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
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
  } catch (err) {
    contentEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">Couldn't load this view</div>
        <p>${err.message}</p>
      </div>
    `;
  }
}

const RENDERERS = {
  overview: async () => {
    const [balance, usage, plans] = await Promise.all([
      apiGet("/balance"),
      apiGet("/usage/summary"),
      apiGet("/plans?per_page=100"),
    ]);
    const activePlans = plans.items.filter((p) => p.status === "active").length;
    return `
      <div class="cards-grid">
        ${statCard("Balance", balance.balance_formatted, "Available to spend")}
        ${statCard("Total Spent", balance.total_spent_formatted, "Lifetime")}
        ${statCard("Active Plans", activePlans, "Across all products")}
        ${statCard("Bandwidth Used", usage.total_bytes_formatted, `This ${usage.period}`)}
      </div>
      <div class="panel">
        <div class="panel-title">Recent Plans</div>
        ${plansTable(plans.items.slice(0, 5))}
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
        ${statCard("Balance", balance.balance_formatted, "Available to spend")}
        ${statCard("Total Spent", balance.total_spent_formatted, "Lifetime")}
        ${allocationCards}
      </div>
      <div class="panel">
        <div class="panel-title">Transaction History</div>
        ${transactionsTable(transactions.items)}
      </div>
      <div class="panel">
        <div class="panel-title">Your Pricing</div>
        <table class="data-table">
          <tr><th>Product</th><th>Billing</th><th>Price</th></tr>
          ${Object.entries(pricing)
            .map(([product, p]) => `<tr><td>${product}</td><td>${p.billing}</td><td>${pricingCell(p)}</td></tr>`)
            .join("")}
        </table>
      </div>
    `;
  },

  plans: async () => {
    const plans = await apiGet("/plans?per_page=100");
    return `<div class="panel"><div class="panel-title">All Plans</div>${plansTable(plans.items)}</div>`;
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
    const planId = plans.items[0]?.plan_id;
    if (!planId) {
      return `<div class="panel"><div class="panel-title">Metrics</div><p>No plans on this account yet.</p></div>`;
    }
    const m = await apiGet(`/plans/${planId}/metrics/summary?hours=24`);
    return `
      <div class="cards-grid">
        ${statCard("Throughput (avg)", `${m.avg_mbps} Mbps`, `Over last ${m.hours}h`)}
        ${statCard("Throughput (peak)", `${m.peak_mbps} Mbps`, "Busiest minute")}
        ${statCard("Success Rate", `${m.success_rate_pct ?? "&mdash;"}%`, `${m.total_successes}/${m.total_connections} connections`)}
        ${statCard("Peak Concurrent", m.peak_concurrent, "Simultaneous connections")}
      </div>
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
    return `
      <div class="panel">
        <div class="panel-title">Sub-Users</div>
        <table class="data-table">
          <tr><th>Name</th><th>Email</th><th>Balance</th><th>Plans</th><th>Status</th></tr>
          ${subUsers.items
            .map(
              (u) => `
            <tr>
              <td>${u.name}</td>
              <td>${u.email}</td>
              <td>$${(u.balance_cents / 100).toFixed(2)}</td>
              <td>${u.plans_count}</td>
              <td><span class="pill pill-active">${u.status}</span></td>
            </tr>`
            )
            .join("")}
        </table>
      </div>
    `;
  },

  usage: async () => {
    const usage = await apiGet("/usage/summary");
    return `
      <div class="cards-grid">${statCard("Total Bandwidth", usage.total_bytes_formatted, `This ${usage.period}`)}</div>
      <div class="panel">
        <div class="panel-title">By Product</div>
        <table class="data-table">
          <tr><th>Product</th><th>Used</th><th>Plans</th></tr>
          ${Object.entries(usage.by_product || {})
            .map(([product, p]) => `<tr><td>${product}</td><td>${p.bytes_formatted}</td><td>${p.plans_count}</td></tr>`)
            .join("")}
        </table>
      </div>
    `;
  },
};

function statCard(label, value, sub) {
  return `
    <div class="stat-card">
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

function pricingCell(p) {
  const parts = [];
  if (p.price_per_gb_formatted) parts.push(`${p.price_per_gb_formatted}/GB`);
  if (p.price_per_day_formatted) parts.push(`${p.price_per_day_formatted}/day`);
  if (p.trial_price_formatted) parts.push(`trial ${p.trial_price_formatted}`);
  return parts.join(" or ") || "&mdash;";
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
