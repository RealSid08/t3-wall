const $ = (id) => document.getElementById(id);

const PROVIDER = {
  codex: { label: "Codex", color: "var(--contrast)", icon: "codex" },
  claude: { label: "Claude", color: "#d97757", icon: "claude" },
  claudeAgent: { label: "Claude", color: "#d97757", icon: "claude" },
  opencode: { label: "OpenCode", color: "#5b9bbd", icon: "opencode" },
  cursor: { label: "Cursor", color: "#a8a8a8", icon: "cursor" },
  grok: { label: "Grok", color: "#cfcfcf", icon: "grok" },
  copilot: { label: "Copilot", color: "#a8a8a8", icon: "copilot" },
  antigravity: { label: "Antigravity", color: "#8c7bd1", icon: "antigravity" },
  openai: { label: "OpenAI", color: "var(--contrast)", icon: "codex" },
};

const LIMIT_ORDER = ["codex", "claude", "opencode", "cursor", "grok", "copilot", "antigravity"];
const ICONS = window.T3WALL_ICONS || {};

const providerInfo = (id) => PROVIDER[id] || { label: id, color: "var(--muted-foreground)", icon: null };

function mark(id, className = "") {
  const info = providerInfo(id);
  const svg = info.icon ? ICONS[info.icon] : null;
  if (!svg) return "";
  return `<span class="mark ${className}" style="color:${info.color}">${svg}</span>`;
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

function fmtUsd(n) {
  const value = n || 0;
  if (value > 0 && value < 1) return "$" + value.toFixed(3);
  return "$" + value.toFixed(value >= 100 ? 0 : 2);
}

function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function since(iso) {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  return isFinite(ms) ? fmtDuration(ms) : "—";
}

function countdown(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!isFinite(ms)) return null;
  return ms <= 0 ? "now" : fmtDuration(ms);
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) {
    if (content instanceof Node) node.append(content);
    else node.innerHTML = content;
  }
  return node;
}

function pctColor(remaining) {
  if (remaining <= 15) return "var(--error)";
  if (remaining <= 35) return "var(--warning)";
  return "var(--success)";
}

// --- Agents -----------------------------------------------------------------

function agentCard(agent) {
  const running = agent.status === "running";
  const card = el("div", "agent" + (running ? " running" : ""));

  const markNode = el("div", "agent-mark", mark(agent.provider));
  card.append(markNode);

  const main = el("div", "agent-main");
  main.append(el("div", "agent-title", agent.title || "(untitled)"));
  const meta = el("div", "agent-meta");
  if (agent.machine) meta.append(el("span", "machine", agent.machine));
  if (agent.model) {
    const model = String(agent.model).split("/").pop();
    meta.append(el("span", "chip", model));
  }
  if (agent.project) meta.append(el("span", "muted", agent.project));
  main.append(meta);
  card.append(main);

  const right = el("div", "agent-right");
  if (running) {
    right.append(el("div", "agent-elapsed", `running for ${since(agent.turnStartedAt || agent.updatedAt)}`));
    right.append(el("div", "agent-sub", `started ${since(agent.createdAt)} ago`));
  } else {
    right.append(el("div", "agent-elapsed", `ran ${since(agent.updatedAt)}`));
  }
  right.append(el("div", "agent-state" + (running ? " live" : ""), running ? "running" : "idle"));
  if (agent.latestActivity && running) {
    right.append(el("div", "agent-activity", agent.latestActivity));
  }
  card.append(right);
  return card;
}

function renderAgents(agents) {
  const host = $("agents");
  host.replaceChildren();
  $("agentCount").textContent = agents.length ? `${agents.length}` : "";
  if (!agents.length) return host.append(el("div", "empty", "No active agents."));
  for (const agent of agents) host.append(agentCard(agent));
}

// --- Limits -----------------------------------------------------------------

function windowRow(key, window) {
  const wrap = el("div", "window");
  const unit = window.unit || "percent";
  let leftText;
  let fill;
  let color;
  if (unit === "percent") {
    const remaining = Number(window.remaining);
    leftText = `${Math.round(remaining)}%`;
    fill = Math.max(0, Math.min(100, remaining));
    color = pctColor(remaining);
  } else {
    const remaining = Number(window.remaining);
    const limit = Number(window.limit);
    leftText = `${remaining}${isFinite(limit) && limit ? " / " + limit : ""} ${unit}`;
    fill = isFinite(limit) && limit > 0 ? (remaining / limit) * 100 : 0;
    color = pctColor(fill);
  }
  const head = el("div", "window-head");
  head.append(el("span", "window-label", key));
  head.append(el("span", "window-left", leftText));
  wrap.append(head);
  const bar = el("div", "bar");
  const fillEl = el("i");
  fillEl.style.width = `${fill}%`;
  fillEl.style.background = color;
  bar.append(fillEl);
  wrap.append(bar);
  const reset = countdown(window.resetsAt);
  wrap.append(el("div", "window-reset", reset ? `resets in ${reset}` : " "));
  return wrap;
}

function renderLimits(limits) {
  const host = $("limits");
  host.replaceChildren();
  if (!limits || limits.ok === false) {
    return host.append(el("div", "empty", "openusage unavailable: " + (limits?.error || "unknown")));
  }
  const providers = limits.providers || {};
  const ids = Object.keys(providers).sort(
    (a, b) => LIMIT_ORDER.indexOf(a) - LIMIT_ORDER.indexOf(b) || a.localeCompare(b),
  );
  if (!ids.length) return host.append(el("div", "empty", "No subscription limits reported."));
  for (const id of ids) {
    const provider = providers[id];
    if (!provider?.resources) continue;
    const windows = Object.entries(provider.resources).filter(([, w]) => w?.kind === "consumption");
    if (!windows.length) continue;
    const card = el("div", "limit");
    const head = el("div", "limit-head");
    head.append(el("div", "limit-id", `${mark(id)}<span>${provider.displayName || providerInfo(id).label}</span>`));
    head.append(el("div", "limit-plan", provider.plan || ""));
    card.append(head);
    for (const [key, window] of windows) card.append(windowRow(key, window));
    host.append(card);
  }
}

// --- Usage ------------------------------------------------------------------

function usageTile(label, summary) {
  const tile = el("div", "tile");
  tile.append(el("div", "tile-label", label));
  tile.append(el("div", "tile-cost", fmtUsd(summary?.costUsd || 0)));
  tile.append(el("div", "tile-tokens", `${fmtTokens(summary?.tokens || 0)} tok`));
  return tile;
}

function renderUsage(usage) {
  const host = $("usage");
  host.replaceChildren();
  const tiles = el("div", "tiles");
  tiles.append(usageTile("24 hours", usage?.today));
  tiles.append(usageTile("7 days", usage?.d7));
  tiles.append(usageTile("30 days", usage?.d30));
  host.append(tiles);

  const d30 = usage?.d30;
  const devices = d30?.devices || [];
  const providers = d30?.providers || [];

  if (devices.length) {
    // Combined across machines (OpenUsage iCloud sync), broken out by machine.
    const list = el("div", "usage-providers");
    for (const device of devices) {
      const row = el("div", "usage-row");
      row.append(el("span", "usage-id", `<span>${device.device}</span>`));
      row.append(el("span", "usage-val", `${fmtUsd(device.costUsd)} · ${fmtTokens(device.tokens)}`));
      list.append(row);
    }
    host.append(list);
  } else if (providers.length) {
    const list = el("div", "usage-providers");
    for (const entry of providers) {
      const row = el("div", "usage-row");
      row.append(el("span", "usage-id", `${mark(entry.provider)}<span>${providerInfo(entry.provider).label}</span>`));
      row.append(el("span", "usage-val", `${fmtUsd(entry.costUsd)} · ${fmtTokens(entry.tokens)}`));
      list.append(row);
    }
    host.append(list);
  }

  if (providers.length) {
    host.append(
      el(
        "div",
        "usage-mix",
        "30d by provider · " +
          providers.map((p) => `${providerInfo(p.provider).label} ${fmtUsd(p.costUsd)}`).join("   ·   "),
      ),
    );
  }
}

// --- Settled ----------------------------------------------------------------

function renderSettled(threads) {
  const host = $("settled");
  host.replaceChildren();
  if (!threads?.length) return host.append(el("div", "empty", "No settled threads."));
  for (const thread of threads) {
    const node = el("div", "recent-row");
    node.append(el("span", "recent-dot"));
    const main = el("div", "recent-main");
    main.append(el("div", "recent-title", thread.title || "(untitled)"));
    const sub = [providerInfo(thread.provider).label, thread.project].filter(Boolean).join(" · ");
    if (sub) main.append(el("div", "recent-project", sub));
    node.append(main);
    node.append(el("div", "recent-meta", `settled ${since(thread.settledAt)} ago`));
    host.append(node);
  }
}

// --- Shell ------------------------------------------------------------------

let latest = null;
let failures = 0;
let scrollTimer = null;
let scrollAt = 0;

function setupAutoScroll() {
  if (scrollTimer) return;
  scrollTimer = setInterval(() => {
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow <= 24) return void (scrollAt = 0);
    scrollAt += window.innerHeight * 0.85;
    if (scrollAt > overflow + window.innerHeight * 0.5) scrollAt = 0;
    window.scrollTo({ top: Math.min(scrollAt, overflow), behavior: "smooth" });
  }, 9000);
}

function renderClock() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function render(state) {
  latest = state;
  renderAgents(state.agents || []);
  renderLimits(state.limits);
  renderUsage(state.usage);
  renderSettled(state.settled);
  $("source").textContent = state.source?.dbAvailable
    ? state.source.label || state.source.t3Home
    : `T3 db unavailable (${state.source?.dbPath || "?"})`;
  const running = (state.agents || []).filter((a) => a.status === "running").length;
  $("statusDot").className = "dot " + (state.limits?.ok === false ? "err" : "live");
  $("statusText").textContent = `${running} running`;
  const peers = state.source?.peers || [];
  const peersHost = $("peers");
  peersHost.replaceChildren();
  for (const peer of peers) {
    peersHost.append(
      el("span", "peer" + (peer.online ? "" : " off"), `<span class="peer-dot"></span>${peer.label}`),
    );
  }
  $("updated").textContent = "updated " + new Date(state.generatedAt).toLocaleTimeString();
}

async function refresh() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    render(await response.json());
    failures = 0;
  } catch (error) {
    failures += 1;
    $("statusDot").className = "dot err";
    $("statusText").textContent = "offline";
    if (failures >= 24) location.reload();
  }
}

function tick() {
  renderClock();
  if (latest) {
    renderAgents(latest.agents || []);
    renderLimits(latest.limits);
    renderSettled(latest.settled);
  }
}

renderClock();
setupAutoScroll();
refresh();
setInterval(refresh, 5000);
setInterval(tick, 1000);
