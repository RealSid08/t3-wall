// t3-wall — a read-only ambient display for T3 Code.
//
// This is a sidecar. It never writes to, restarts, or reconfigures T3 Code.
// It reads T3's on-disk projections/usage caches read-only and shells out to
// `openusage` for subscription limits, then serves a portrait-friendly page.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || homedir();
const T3_HOME = process.env.T3_WALL_T3_HOME || join(HOME, ".t3");
const USERDATA = join(T3_HOME, "userdata");
const DB_PATH = join(USERDATA, "state.sqlite");
const SCAN_CACHE_PATH = join(USERDATA, "usage-scan-cache.json");
const RATES_PATH = join(USERDATA, "usage-model-rates.json");
const PORT = Number(process.env.T3_WALL_PORT || 4123);
const HOST = process.env.T3_WALL_HOST || "127.0.0.1";
const OPENUSAGE_BIN = process.env.T3_WALL_OPENUSAGE || "openusage";
const LOCAL_LABEL = process.env.T3_WALL_LOCAL_LABEL || "This Mac";
const OPENUSAGE_HISTORY_DIR =
  process.env.T3_WALL_OPENUSAGE_HISTORY ||
  join(
    HOME,
    "Library",
    "Mobile Documents",
    "iCloud~com~robinebers~openusage",
    "OpenUsage",
    "History",
    "v1",
  );

// Peer T3 environments read over SSH (see ~/.ssh/config). `host:Label` pairs.
const PEERS: { host: string; label: string }[] = (process.env.T3_WALL_PEERS ?? "m5:M5,pi:Pi")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const index = entry.indexOf(":");
    const host = (index === -1 ? entry : entry.slice(0, index)).trim();
    const label = (index === -1 ? entry : entry.slice(index + 1)).trim() || host;
    return { host, label };
  });

const startedAt = Date.now();

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return null;
  }
}

function parseModelSelection(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

function openReadOnlyDatabase(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    return db;
  } catch {
    return null;
  }
}

// --- Agents -----------------------------------------------------------------

interface AgentRow {
  thread_id: string;
  title: string;
  project_title: string | null;
  workspace_root: string | null;
  status: string;
  provider_name: string | null;
  provider_instance_id: string | null;
  active_turn_id: string | null;
  last_error: string | null;
  updated_at: string;
  model_selection_json: string | null;
  latest_activity: string | null;
  latest_activity_at: string | null;
  turn_started_at: string | null;
  created_at: string | null;
}

function readAgents(db: Database): Json[] {
  const rows = db
    .query(
      `SELECT
         t.thread_id, t.title, p.title AS project_title, p.workspace_root,
         s.status, s.provider_name, s.provider_instance_id, s.active_turn_id,
         s.last_error, s.updated_at, t.model_selection_json, t.created_at,
         (SELECT a.summary FROM projection_thread_activities a
            WHERE a.thread_id = t.thread_id
            ORDER BY a.created_at DESC LIMIT 1) AS latest_activity,
         (SELECT a.created_at FROM projection_thread_activities a
            WHERE a.thread_id = t.thread_id
            ORDER BY a.created_at DESC LIMIT 1) AS latest_activity_at,
         (SELECT tu.requested_at FROM projection_turns tu
            WHERE tu.thread_id = t.thread_id AND tu.turn_id = s.active_turn_id
            LIMIT 1) AS turn_started_at
       FROM projection_thread_sessions s
       JOIN projection_threads t ON t.thread_id = s.thread_id
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
       WHERE s.status IN ('running', 'ready')
         AND t.archived_at IS NULL
       ORDER BY CASE s.status WHEN 'running' THEN 0 ELSE 1 END, s.updated_at DESC`,
    )
    .all() as AgentRow[];

  return rows.map((row) => ({
    threadId: row.thread_id,
    title: row.title,
    project: row.project_title ?? row.workspace_root ?? null,
    status: row.status,
    provider: row.provider_name ?? row.provider_instance_id ?? null,
    model: parseModelSelection(row.model_selection_json),
    activeTurnId: row.active_turn_id,
    lastError: row.last_error,
    updatedAt: row.updated_at,
    turnStartedAt: row.turn_started_at,
    createdAt: row.created_at,
    latestActivity: row.latest_activity,
    latestActivityAt: row.latest_activity_at,
  }));
}

// --- Recent completions and errors -----------------------------------------

function readRecent(db: Database): { completions: Json[]; errors: Json[] } {
  const completions = (
    db
      .query(
        `SELECT t.title, tu.requested_at, tu.completed_at
         FROM projection_turns tu
         JOIN projection_threads t ON t.thread_id = tu.thread_id
         WHERE tu.completed_at IS NOT NULL
         ORDER BY tu.completed_at DESC LIMIT 8`,
      )
      .all() as { title: string; requested_at: string; completed_at: string }[]
  ).map((row) => ({
    title: row.title,
    startedAt: row.requested_at,
    completedAt: row.completed_at,
    durationMs: Date.parse(row.completed_at) - Date.parse(row.requested_at),
  }));

  const errors = (
    db
      .query(
        `SELECT t.title, a.summary, a.kind, a.created_at
         FROM projection_thread_activities a
         JOIN projection_threads t ON t.thread_id = a.thread_id
         WHERE a.tone = 'error'
         ORDER BY a.created_at DESC LIMIT 6`,
      )
      .all() as { title: string; summary: string; kind: string; created_at: string }[]
  ).map((row) => ({
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    at: row.created_at,
  }));

  return { completions, errors };
}

// --- Settled threads --------------------------------------------------------

function readSettled(db: Database): Json[] {
  const rows = db
    .query(
      `SELECT t.thread_id, t.title, p.title AS project_title, p.workspace_root,
              t.settled_at, s.provider_name, s.provider_instance_id
       FROM projection_threads t
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
       LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
       WHERE t.settled_at IS NOT NULL AND t.archived_at IS NULL
       ORDER BY t.settled_at DESC
       LIMIT 8`,
    )
    .all() as {
    thread_id: string;
    title: string;
    project_title: string | null;
    workspace_root: string | null;
    settled_at: string;
    provider_name: string | null;
    provider_instance_id: string | null;
  }[];
  return rows.map((row) => ({
    threadId: row.thread_id,
    title: row.title,
    project: row.project_title ?? row.workspace_root ?? null,
    provider: row.provider_name ?? row.provider_instance_id ?? null,
    settledAt: row.settled_at,
  }));
}

// --- Subscription limits (openusage) ---------------------------------------

async function readLimits(): Promise<Json> {
  try {
    const proc = Bun.spawn([OPENUSAGE_BIN], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const json = JSON.parse(text) as Json;
    return { ok: true, ...json };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// --- Peer environments (other T3 machines, over SSH) -----------------------

const PEER_SCRIPT = `
import sqlite3, json, os
db = os.path.expanduser("~/.t3/userdata/state.sqlite")
out = {"agents": [], "settled": []}
try:
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    con.row_factory = sqlite3.Row
    out["agents"] = [dict(r) for r in con.execute("""
        SELECT t.thread_id AS threadId, t.title AS title, p.title AS project,
               s.status AS status, s.provider_name AS provider,
               t.model_selection_json AS modelJson, s.updated_at AS updatedAt,
               t.created_at AS createdAt,
               (SELECT tu.requested_at FROM projection_turns tu
                  WHERE tu.thread_id = t.thread_id AND tu.turn_id = s.active_turn_id LIMIT 1) AS turnStartedAt,
               (SELECT a.summary FROM projection_thread_activities a
                  WHERE a.thread_id = t.thread_id ORDER BY a.created_at DESC LIMIT 1) AS latestActivity,
               (SELECT a.created_at FROM projection_thread_activities a
                  WHERE a.thread_id = t.thread_id ORDER BY a.created_at DESC LIMIT 1) AS latestActivityAt
        FROM projection_thread_sessions s
        JOIN projection_threads t ON t.thread_id = s.thread_id
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE s.status IN ('running','ready') AND t.archived_at IS NULL
        ORDER BY CASE s.status WHEN 'running' THEN 0 ELSE 1 END, s.updated_at DESC LIMIT 12
    """)]
    out["settled"] = [dict(r) for r in con.execute("""
        SELECT t.title AS title, p.title AS project, t.settled_at AS settledAt,
               s.provider_name AS provider
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
        WHERE t.settled_at IS NOT NULL AND t.archived_at IS NULL
        ORDER BY t.settled_at DESC LIMIT 8
    """)]
except Exception as error:
    out["error"] = str(error)
print(json.dumps(out))
`;
const PEER_SCRIPT_B64 = Buffer.from(PEER_SCRIPT).toString("base64");

interface PeerSnapshot {
  host: string;
  label: string;
  online: boolean;
  agents: Json[];
  settled: Json[];
}

async function readPeer(peer: { host: string; label: string }): Promise<PeerSnapshot> {
  const offline: PeerSnapshot = { host: peer.host, label: peer.label, online: false, agents: [], settled: [] };
  try {
    const decode = `import base64;exec(base64.b64decode('${PEER_SCRIPT_B64}'))`;
    const command = `python3 -c "${decode}" 2>/dev/null || /usr/bin/python3 -c "${decode}" 2>/dev/null`;
    const proc = Bun.spawn(
      [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=6",
        "-o", "ControlMaster=auto",
        "-o", "ControlPath=/tmp/t3wall-ssh-%h",
        "-o", "ControlPersist=120",
        peer.host,
        command,
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const guard = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }, 8000);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(guard);
    if (code !== 0 || !text.trim()) return offline;
    const data = JSON.parse(text) as { agents?: Json[]; settled?: Json[] };
    const agents = (data.agents ?? []).map((agent) => ({
      ...agent,
      machine: peer.label,
      model: parseModelSelection(agent.modelJson),
    }));
    const settled = (data.settled ?? []).map((thread) => ({ ...thread, machine: peer.label }));
    return { host: peer.host, label: peer.label, online: true, agents, settled };
  } catch {
    return offline;
  }
}

let peersCache: { at: number; value: PeerSnapshot[] } | null = null;
const PEERS_TTL_MS = 15_000;

async function readPeersCached(): Promise<PeerSnapshot[]> {
  if (peersCache && Date.now() - peersCache.at < PEERS_TTL_MS) return peersCache.value;
  const value = await Promise.all(PEERS.map(readPeer));
  peersCache = { at: Date.now(), value };
  return value;
}

// --- Usage (today's tokens and cost) ---------------------------------------

interface UsageRecord {
  provider: string;
  timestampMs: number;
  model: string;
  session: string;
  uncachedInput: number;
  cachedInput: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  reportedCostUsd: number | null;
}

function startOfTodayMs(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function decodeScanCache(): UsageRecord[] {
  const cache = readJson(SCAN_CACHE_PATH) as
    | { models?: string[]; sessions?: string[]; files?: Record<string, Json> }
    | null;
  if (!cache?.files) return [];
  const models = cache.models ?? [];
  const sessions = cache.sessions ?? [];
  const records: UsageRecord[] = [];
  const push = (provider: string, raw: unknown) => {
    if (!Array.isArray(raw) || raw.length < 8) return;
    const timestampMs = Number(raw[0]);
    if (!Number.isFinite(timestampMs)) return;
    records.push({
      provider,
      timestampMs,
      model: models[Number(raw[1])] ?? "",
      session: sessions[Number(raw[2])] ?? "",
      uncachedInput: Number(raw[3]) || 0,
      cachedInput: Number(raw[4]) || 0,
      cacheCreation: Number(raw[5]) || 0,
      output: Number(raw[6]) || 0,
      reasoning: Number(raw[7]) || 0,
      reportedCostUsd: typeof raw[9] === "number" && raw[9] > 0 ? (raw[9] as number) : null,
    });
  };
  for (const file of Object.values(cache.files)) {
    const provider = typeof file.p === "string" ? file.p : "unknown";
    for (const record of (file.r as unknown[]) ?? []) push(provider, record);
    for (const record of (file.t as unknown[]) ?? []) push(provider, record);
  }
  return records;
}

function openCodeDatabases(): string[] {
  const roots = new Set<string>();
  if (process.env.OPENCODE_DATA_DIR) {
    for (const entry of process.env.OPENCODE_DATA_DIR.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) roots.add(trimmed);
    }
  }
  const share = join(HOME, ".local", "share");
  if (existsSync(share)) {
    for (const name of readdirSync(share)) {
      if (!name.startsWith("opencode")) continue;
      for (const candidate of [
        join(share, name, "opencode", "opencode.db"),
        join(share, name, "opencode.db"),
      ]) {
        if (existsSync(candidate)) roots.add(candidate.slice(0, -"opencode.db".length) + "opencode.db");
      }
    }
  }
  for (const fallback of [
    join(share, "opencode", "opencode.db"),
    join(HOME, ".local", "share", "opencode", "storage", "opencode.db"),
  ]) {
    if (existsSync(fallback)) roots.add(fallback);
  }
  return [...roots];
}

function readOpenCodeUsage(sinceMs: number): UsageRecord[] {
  const out: UsageRecord[] = [];
  const seen = new Set<string>();
  for (const path of openCodeDatabases()) {
    const db = openReadOnlyDatabase(path);
    if (!db) continue;
    try {
      const tables = new Set(
        (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      for (const table of ["message", "session_message"]) {
        if (!tables.has(table)) continue;
        const columns = new Set(
          (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
        );
        const hasTime = columns.has("time_created");
        const where = hasTime ? "WHERE time_created >= ?" : "";
        const rows = db
          .query(`SELECT id, session_id, data FROM ${table} ${where}`)
          .all(...(hasTime ? [sinceMs] : [])) as { id: string; session_id: string; data: string }[];
        for (const row of rows) {
          const record = parseOpenCodeMessage(row.data, row.id, row.session_id);
          if (!record || record.timestampMs < sinceMs) continue;
          if (seen.has(`opencode:${row.id}`)) continue;
          seen.add(`opencode:${row.id}`);
          out.push(record);
        }
      }
    } catch {
      // ignore a locked or schema-shifted database
    } finally {
      db.close();
    }
  }
  return out;
}

function parseOpenCodeMessage(source: string, id: string, sessionId: string): UsageRecord | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(source) as Json;
  } catch {
    return null;
  }
  if (parsed.role !== undefined && parsed.role !== "assistant") return null;
  const usage = (parsed.tokens ?? {}) as Json;
  const cache = (usage.cache ?? {}) as Json;
  const modelRef = (parsed.model ?? {}) as Json;
  const model =
    (typeof modelRef.id === "string" && modelRef.id) ||
    (typeof modelRef.modelID === "string" && modelRef.modelID) ||
    (typeof parsed.modelID === "string" && parsed.modelID) ||
    "";
  const time = (parsed.time ?? {}) as Json;
  const timestampMs = typeof time.created === "number" ? time.created : NaN;
  if (!model || !Number.isFinite(timestampMs)) return null;
  const num = (value: unknown) => (typeof value === "number" && value > 0 ? Math.trunc(value) : 0);
  const reasoning = num(usage.reasoning);
  const record: UsageRecord = {
    provider: "opencode",
    timestampMs,
    model,
    uncachedInput: num(usage.input),
    cachedInput: num(cache.read),
    cacheCreation: num(cache.write),
    output: num(usage.output) + reasoning,
    reasoning,
    reportedCostUsd: typeof parsed.cost === "number" && parsed.cost > 0 ? parsed.cost : null,
  };
  if (
    record.uncachedInput + record.cachedInput + record.cacheCreation + record.output + record.reasoning ===
    0
  ) {
    return null;
  }
  return record;
}

interface Rates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function loadRates(): Record<string, Rates> {
  const doc = (readJson(RATES_PATH) as { document?: Json } | null)?.document ?? {};
  const rates: Record<string, Rates> = {};
  for (const [model, entry] of Object.entries(doc)) {
    const value = entry as Json;
    const input = Number(value.input_cost_per_token);
    const output = Number(value.output_cost_per_token);
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue;
    rates[model.toLowerCase()] = {
      input: Number.isFinite(input) ? input : undefined,
      output: Number.isFinite(output) ? output : undefined,
      cacheRead: Number.isFinite(Number(value.cache_read_input_token_cost))
        ? Number(value.cache_read_input_token_cost)
        : undefined,
      cacheWrite: Number.isFinite(Number(value.cache_creation_input_token_cost))
        ? Number(value.cache_creation_input_token_cost)
        : undefined,
    };
  }
  return rates;
}

function lookupRates(rates: Record<string, Rates>, model: string): Rates | null {
  const key = model.toLowerCase();
  if (rates[key]) return rates[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (rates[bare]) return rates[bare];
  for (const [candidate, value] of Object.entries(rates)) {
    if (candidate.endsWith(`/${bare}`) || candidate.endsWith(`.${bare}`)) return value;
  }
  return null;
}

function estimateCost(record: UsageRecord, rates: Record<string, Rates>): number | null {
  const rate = lookupRates(rates, record.model);
  if (!rate) return record.reportedCostUsd;
  const input = rate.input ?? 0;
  const cost =
    record.uncachedInput * input +
    record.cachedInput * (rate.cacheRead ?? input) +
    record.cacheCreation * (rate.cacheWrite ?? input) +
    record.output * (rate.output ?? 0);
  return cost > 0 ? cost : record.reportedCostUsd;
}

interface UsageDay {
  date: string;
  costUsd: number;
  tokens: number;
  devices: Map<string, { costUsd: number; tokens: number }>;
  providers: Map<string, { costUsd: number; tokens: number }>;
}

/**
 * OpenUsage mirrors every machine's daily cost/tokens into an iCloud container.
 * Reading it is what gives us the combined-across-machines number, the same
 * way the OpenUsage app shows it.
 */
function readOpenUsageHistory(): { available: boolean; days: Map<string, UsageDay> } {
  const days = new Map<string, UsageDay>();
  if (!existsSync(OPENUSAGE_HISTORY_DIR)) return { available: false, days };
  let files: string[] = [];
  try {
    files = readdirSync(OPENUSAGE_HISTORY_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return { available: false, days };
  }
  for (const file of files) {
    const doc = readJson(join(OPENUSAGE_HISTORY_DIR, file)) as
      | { deviceName?: string; providers?: Record<string, { series?: { daily?: unknown[] } }> }
      | null;
    if (!doc?.providers) continue;
    const device = doc.deviceName || "unknown";
    for (const [provider, entry] of Object.entries(doc.providers)) {
      const daily = entry?.series?.daily;
      if (!Array.isArray(daily)) continue;
      for (const raw of daily) {
        const row = raw as { date?: string; costUSD?: number; totalTokens?: number };
        if (typeof row.date !== "string") continue;
        const day =
          days.get(row.date) ??
          { date: row.date, costUsd: 0, tokens: 0, devices: new Map(), providers: new Map() };
        const cost = Number(row.costUSD) || 0;
        const tokens = Number(row.totalTokens) || 0;
        day.costUsd += cost;
        day.tokens += tokens;
        const deviceBucket = day.devices.get(device) ?? { costUsd: 0, tokens: 0 };
        deviceBucket.costUsd += cost;
        deviceBucket.tokens += tokens;
        day.devices.set(device, deviceBucket);
        const bucket = day.providers.get(provider) ?? { costUsd: 0, tokens: 0 };
        bucket.costUsd += cost;
        bucket.tokens += tokens;
        day.providers.set(provider, bucket);
        days.set(row.date, day);
      }
    }
  }
  return { available: days.size > 0, days };
}

function dateKey(offsetDays: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function summarizeUsage(): Json {
  const history = readOpenUsageHistory();
  if (!history.available) return summarizeLocalUsage();

  const window = (days: number) => {
    const cutoff = dateKey(days - 1);
    const costUsd = { total: 0 };
    const tokens = { total: 0 };
    const providers = new Map<string, { provider: string; costUsd: number; tokens: number }>();
    const devices = new Map<string, { device: string; costUsd: number; tokens: number }>();
    for (const [date, day] of history.days) {
      if (date < cutoff) continue;
      costUsd.total += day.costUsd;
      tokens.total += day.tokens;
      for (const [provider, bucket] of day.providers) {
        const entry = providers.get(provider) ?? { provider, costUsd: 0, tokens: 0 };
        entry.costUsd += bucket.costUsd;
        entry.tokens += bucket.tokens;
        providers.set(provider, entry);
      }
      for (const [device, bucket] of day.devices) {
        const entry = devices.get(device) ?? { device, costUsd: 0, tokens: 0 };
        entry.costUsd += bucket.costUsd;
        entry.tokens += bucket.tokens;
        devices.set(device, entry);
      }
    }
    return {
      costUsd: costUsd.total,
      tokens: tokens.total,
      providers: [...providers.values()].sort((a, b) => b.costUsd - a.costUsd),
      devices: [...devices.values()].sort((a, b) => b.costUsd - a.costUsd),
    };
  };

  return {
    source: "openusage-icloud",
    today: window(1),
    d7: window(7),
    d30: window(30),
  };
}

interface UsageWindowSummary {
  since: string;
  tokens: number;
  costUsd: number;
  breakdown: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number };
  providers: { provider: string; tokens: number; costUsd: number; costKnown: boolean; records: number }[];
}

function summarizeLocalUsage(): Json {
  const rates = loadRates();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const records = [...decodeScanCache(), ...readOpenCodeUsage(now - 30 * day)];

  const empty = (since: number): UsageWindowSummary => ({
    since: new Date(since).toISOString(),
    tokens: 0,
    costUsd: 0,
    breakdown: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    providers: [],
  });

  const windows: Record<string, UsageWindowSummary & { byProvider: Map<string, UsageWindowSummary["providers"][number]> }> = {
    today: { ...empty(startOfTodayMs()), byProvider: new Map() },
    d7: { ...empty(now - 7 * day), byProvider: new Map() },
    d30: { ...empty(now - 30 * day), byProvider: new Map() },
  };

  for (const record of records) {
    const total =
      record.uncachedInput + record.cachedInput + record.cacheCreation + record.output + record.reasoning;
    const cost = estimateCost(record, rates);
    for (const window of Object.values(windows)) {
      if (record.timestampMs < Date.parse(window.since)) continue;
      window.tokens += total;
      window.costUsd += cost ?? 0;
      window.breakdown.input += record.uncachedInput;
      window.breakdown.cached += record.cachedInput;
      window.breakdown.cacheWrite += record.cacheCreation;
      window.breakdown.output += record.output;
      window.breakdown.reasoning += record.reasoning;
      const entry = window.byProvider.get(record.provider) ?? {
        provider: record.provider,
        tokens: 0,
        costUsd: 0,
        costKnown: true,
        records: 0,
      };
      entry.tokens += total;
      entry.records += 1;
      if (cost === null) entry.costKnown = false;
      else entry.costUsd += cost;
      window.byProvider.set(record.provider, entry);
    }
  }

  for (const window of Object.values(windows)) {
    window.providers = [...window.byProvider.values()].sort((a, b) => b.tokens - a.tokens);
    delete (window as { byProvider?: unknown }).byProvider;
  }

  return {
    today: windows.today,
    d7: windows.d7,
    d30: windows.d30,
  };
}

// --- Aggregation ------------------------------------------------------------

let limitsCache: { at: number; value: Json } | null = null;
let usageCache: { at: number; value: Json } | null = null;
const CACHE_TTL_MS = 60_000;

async function readLimitsCached(): Promise<Json> {
  if (limitsCache && Date.now() - limitsCache.at < CACHE_TTL_MS) return limitsCache.value;
  const value = await readLimits();
  limitsCache = { at: Date.now(), value };
  return value;
}

function summarizeUsageCached(): Json {
  if (usageCache && Date.now() - usageCache.at < CACHE_TTL_MS) return usageCache.value;
  const value = summarizeUsage();
  usageCache = { at: Date.now(), value };
  return value;
}

async function buildState(): Promise<Json> {
  const db = openReadOnlyDatabase(DB_PATH);
  let agents: Json[] = [];
  let settled: Json[] = [];
  if (db) {
    try {
      agents = readAgents(db).map((agent) => ({ ...agent, machine: LOCAL_LABEL }));
      settled = readSettled(db).map((thread) => ({ ...thread, machine: LOCAL_LABEL }));
    } finally {
      db.close();
    }
  }

  const [limits, usage, peers] = await Promise.all([
    readLimitsCached(),
    Promise.resolve(summarizeUsageCached()),
    readPeersCached(),
  ]);

  for (const peer of peers) {
    agents.push(...peer.agents);
    settled.push(...peer.settled);
  }
  agents.sort((a, b) => {
    const rank = (agent: Json) => (agent.status === "running" ? 0 : 1);
    return rank(a) - rank(b) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });
  settled.sort((a, b) => String(b.settledAt ?? "").localeCompare(String(a.settledAt ?? "")));

  const peerStatus = peers.map((peer) => ({
    host: peer.host,
    label: peer.label,
    online: peer.online,
    agents: peer.agents.length,
  }));

  return {
    generatedAt: new Date().toISOString(),
    uptimeMs: Date.now() - startedAt,
    source: {
      t3Home: T3_HOME,
      dbPath: DB_PATH,
      dbAvailable: db !== null,
      label: process.env.T3_WALL_LABEL || hostname().replace(/\.local$/, ""),
      peers: peerStatus,
    },
    agents,
    settled: settled.slice(0, 10),
    limits,
    usage,
  };
}

// --- HTTP -------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const PUBLIC_DIR = join(import.meta.dir, "public");

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/state") return json(await buildState());
    if (url.pathname === "/health") return json({ ok: true });
    const file =
      url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "").replace(/\.\./g, "");
    const path = join(PUBLIC_DIR, file);
    if (existsSync(path)) {
      return new Response(Bun.file(path), { headers: { "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`t3-wall serving http://${HOST}:${PORT}  (T3 home: ${T3_HOME})`);
