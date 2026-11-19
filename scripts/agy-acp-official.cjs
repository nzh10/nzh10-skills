#!/usr/bin/env node
"use strict";
// Shim for `agy acp` (1.5.11+):
// 1) Injects missing `mcpCapabilities.http` on `initialize`;
// 2) Answers standalone `/usage` prompts on fresh `session/new` sessions via CCPA quota API (0 LLM tokens);
// 3) Self-heals legacy non-secret `acp_token.json` preflight marker;
// 4) Keeps `agy acp` alive in a detached per-session holder while swarm members,
//    subagents, or descendant processes are active, and reattaches seamlessly
//    (with a direct HTTP/SSE reverse proxy for hot-swapping `pi-bridge`, and
//    strict single-owner POSIX socket exclusivity so SQLite is never double-opened).
//
// Binary resolution order: $AGY_REAL_BIN -> ~/.local/bin/agy -> first executable `agy` on $PATH.
// Optional wiring: point `pi-antigravity-acp-provider` binary config at this script.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

http.setGlobalProxyFromEnv?.();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function effectiveHome() {
  return process.env.HOME?.trim() || os.homedir();
}

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(binName) {
  const selfReal = (() => {
    try {
      return fs.realpathSync(__filename);
    } catch {
      return path.resolve(__filename);
    }
  })();
  const pathEnv = process.env.PATH || "";
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (!isExecutableFile(candidate)) continue;
    try {
      if (fs.realpathSync(candidate) === selfReal) continue;
    } catch {}
    return path.resolve(candidate);
  }
  return null;
}

function resolveAgyRealBin() {
  const override = process.env.AGY_REAL_BIN?.trim();
  if (override) {
    if (override.includes("/") || override.includes("\\")) {
      const expanded = override.startsWith("~/") || override.startsWith("~\\")
        ? path.join(effectiveHome(), override.slice(2))
        : override;
      return path.resolve(expanded);
    }
    return resolveFromPath(override) || override;
  }
  const defaultLocalBin = path.join(effectiveHome(), ".local", "bin", "agy");
  if (isExecutableFile(defaultLocalBin)) {
    return defaultLocalBin;
  }
  return resolveFromPath("agy") || defaultLocalBin;
}

const AGY_REAL_BIN = resolveAgyRealBin();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parsePositiveInt(raw, fallback, min = 0) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

const HOLDER_POLL_MS = parsePositiveInt(process.env.AGY_ACP_HOLDER_POLL_MS, 5_000, 50);
const HOLDER_GRACE_MS = parsePositiveInt(process.env.AGY_ACP_HOLDER_GRACE_MS, 15_000, 0);
const ATTACH_TIMEOUT_MS = parsePositiveInt(process.env.AGY_ACP_ATTACH_TIMEOUT_MS, 2_000, 200);
const EVICT_TIMEOUT_MS = parsePositiveInt(process.env.AGY_ACP_EVICT_TIMEOUT_MS, 5_000, 500);
const PROMPT_BARRIER_MS = parsePositiveInt(process.env.AGY_ACP_PROMPT_BARRIER_MS, 5_000, 200);
const PERMISSION_QUEUE_MS = parsePositiveInt(process.env.AGY_ACP_PERMISSION_QUEUE_MS, 60_000, 500);
const HOLDER_DISABLED = process.env.AGY_ACP_DISABLE_HOLDER === "1";

function resolveCliAppDir() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (appDir) return appDir;
  const geminiHome = process.env.GEMINI_HOME?.trim() || path.join(effectiveHome(), ".gemini");
  return path.join(geminiHome, "antigravity-cli");
}

function resolveCliTokenPath() {
  return path.join(resolveCliAppDir(), "antigravity-oauth-token");
}

function resolveHoldersDir() {
  const custom = process.env.AGY_ACP_HOLDERS_DIR?.trim();
  if (custom) return custom;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `agy-acp-holders-${uid}`);
}

// Verifies holders dir is owned by current uid, not a symlink, and not group/other accessible.
function ensureSecureHoldersDir() {
  const dir = resolveHoldersDir();
  const myUid = typeof process.getuid === "function" ? process.getuid() : null;
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      st = fs.lstatSync(dir);
    } else {
      throw err;
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Unsafe holders dir (symlink or non-directory): ${dir}`);
  }
  if (myUid !== null && st.uid !== myUid) {
    throw new Error(`Unsafe holders dir owner (uid=${st.uid}, expected=${myUid}): ${dir}`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    st = fs.lstatSync(dir);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`Unsafe holders dir mode (${(st.mode & 0o777).toString(8)}): ${dir}`);
    }
  }
  return dir;
}

function sessionSocketPath(sessionId) {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return null;
  return path.join(resolveHoldersDir(), `s-${sessionId}.sock`);
}

function initCachePath() {
  return path.join(resolveHoldersDir(), "init-cache.json");
}

function binSignature() {
  try {
    const st = fs.statSync(AGY_REAL_BIN);
    return { binPath: AGY_REAL_BIN, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  } catch {
    return null;
  }
}

function readValidInitCache() {
  const sig = binSignature();
  if (!sig) return null;
  try {
    ensureSecureHoldersDir();
    const data = JSON.parse(fs.readFileSync(initCachePath(), "utf8"));
    if (
      data?.binPath === sig.binPath &&
      data?.size === sig.size &&
      data?.mtimeMs === sig.mtimeMs &&
      data?.result &&
      typeof data.result === "object"
    ) {
      return data.result;
    }
  } catch {}
  return null;
}

function writeInitCache(result) {
  const sig = binSignature();
  if (!sig || !result || typeof result !== "object") return;
  try {
    const dir = ensureSecureHoldersDir();
    const tmp = path.join(dir, `.init-cache.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ ...sig, result }), { mode: 0o600 });
    fs.renameSync(tmp, initCachePath());
  } catch {}
}

function hasAnySessionSocket() {
  try {
    const dir = ensureSecureHoldersDir();
    return fs.readdirSync(dir).some((name) => name.startsWith("s-") && name.endsWith(".sock"));
  } catch {
    return false;
  }
}

function removeUsageConversation(sessionId) {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return;
  const convDir = path.join(resolveCliAppDir(), "conversations");
  for (const suffix of [".db", ".db-shm", ".db-wal", ".meta"]) {
    try {
      fs.rmSync(path.join(convDir, sessionId + suffix), { force: true });
    } catch {}
  }
}

function syncLegacyAuthMarker() {
  try {
    if (!fs.existsSync(resolveCliTokenPath())) return;
    const geminiHome = process.env.GEMINI_HOME?.trim() || path.join(effectiveHome(), ".gemini");
    const legacyDir = path.join(geminiHome, "antigravity-acp");
    const legacyToken = path.join(legacyDir, "acp_token.json");
    if (fs.existsSync(legacyToken)) return;
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyToken, '{"refresh_token":"managed-by-antigravity-cli"}\n', { mode: 0o600 });
  } catch {}
}

function formatResetUtc(raw) {
  const d = typeof raw === "string" && raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

async function buildQuotaMarkdown(apiKeyAuth) {
  if (apiKeyAuth) return "### Quota Limits\n- Not applicable for current authentication method.";
  let accessToken;
  try {
    const tok = JSON.parse(fs.readFileSync(resolveCliTokenPath(), "utf8"));
    accessToken = tok?.token?.access_token;
  } catch {}
  if (!accessToken) {
    return "### Quota Limits\n- Unable to retrieve quota status (not signed in; run 'agy acp --login')";
  }
  try {
    const prodBase = "https://cloudcode-pa.googleapis.com";
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": `antigravity/acp/1.5.11 (aidev_client; os_type=${os.platform()}; arch=${arch})`,
    };
    const lcaRes = await fetch(`${prodBase}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!lcaRes.ok) throw new Error(`loadCodeAssist HTTP ${lcaRes.status}`);
    const lca = await lcaRes.json();
    const project = lca?.cloudaicompanionProject;
    if (!project) throw new Error("no cloudaicompanionProject resolved");
    const quotaBase = lca?.paidTier?.usesGcpTos ? prodBase : "https://daily-cloudcode-pa.googleapis.com";
    const qRes = await fetch(`${quotaBase}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!qRes.ok) throw new Error(`retrieveUserQuotaSummary HTTP ${qRes.status}`);
    const quota = await qRes.json();
    const groups = Array.isArray(quota?.groups) ? quota.groups : [];
    if (!groups.length) return "### Quota Limits\n- No quota limits reported.";
    const lines = ["### Quota Limits"];
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      lines.push(`- **${g.displayName ?? g.display_name ?? "Models"}**`);
      for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
        if (!b || typeof b !== "object") continue;
        const name = b.displayName ?? b.display_name ?? b.window ?? b.bucketId ?? "Limit";
        if (b.disabled) {
          lines.push(`  - **${name}:** ${b.description ? `Disabled: ${b.description}` : "Disabled"}`);
          continue;
        }
        const frac = b.remainingFraction ?? b.remaining_fraction;
        const amt = b.remainingAmount ?? b.remaining_amount;
        let rem = "Available";
        if (frac !== undefined && frac !== null && Number.isFinite(Number(frac))) {
          rem = `${Math.round(Number(frac) * 100)}% remaining`;
        } else if (amt !== undefined && amt !== null && Number.isFinite(Number(amt))) {
          rem = `${Math.trunc(Number(amt)).toLocaleString("en-US")} units remaining`;
        }
        const reset = formatResetUtc(b.resetTime ?? b.reset_time);
        lines.push(`  - **${name}:** ${rem}${reset ? ` (resets ${reset})` : ""}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `### Quota Limits\n- Unable to retrieve quota status (${err instanceof Error ? err.message : String(err)})`;
  }
}

function parseUsageArgs(prompt) {
  if (!Array.isArray(prompt)) return null;
  const text = prompt.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
  if (!/^\/usage(?:\s|$)/iu.test(text)) return null;
  return text.slice(6).trim();
}

function exitCleanly(exitCode) {
  syncLegacyAuthMarker();
  if (!process.stdout.isTTY && !process.stdout.destroyed && !process.stdout.writableEnded) {
    process.stdout.once("close", () => process.exit(exitCode));
    process.stdout.end(() => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}

function attachLineReader(stream, onLine) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (line.length) onLine(line);
    }
  };
  const onEnd = () => {
    if (buf.length) {
      const line = buf.toString("utf8").replace(/\r$/, "");
      buf = Buffer.alloc(0);
      if (line.length) onLine(line);
    }
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

// Scans /proc (only called when detached) to detect any live descendant, process-group, or session member of agyPid.
function hasLiveDescendantProcess(agyPid) {
  if (!agyPid || process.platform !== "linux") return false;
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return false;
  }
  const procs = new Map();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === agyPid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const rp = stat.lastIndexOf(")");
      if (rp < 0) continue;
      const fields = stat.slice(rp + 2).split(" ");
      const state = fields[0];
      if (state === "Z" || state === "X") continue;
      const ppid = Number(fields[1]);
      const pgrp = Number(fields[2]);
      const sid = Number(fields[3]);
      if (ppid === agyPid || pgrp === agyPid || sid === agyPid) return true;
      procs.set(pid, ppid);
    } catch {}
  }
  for (const initialParent of procs.values()) {
    let cur = initialParent;
    let depth = 0;
    while (cur > 1 && depth < 16) {
      if (cur === agyPid) return true;
      cur = procs.get(cur) || 0;
      depth++;
    }
  }
  return false;
}

// Returns true whenever this session has active background work:
// - any live descendant / process-group / session process under agyPid;
// - any non-coordinator, non-killed swarm member that is RUNNING (or working / pending nudge);
// - any SUBAGENT_STATE_ALIVE subagent (not marked killed in members.json).
function hasActiveBackgroundWork(sessionId, agyPid) {
  if (agyPid && hasLiveDescendantProcess(agyPid)) return true;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return false;

  const sysGenDir = path.join(resolveCliAppDir(), "brain", sessionId, ".system_generated");
  const killedConvIds = new Set();

  const membersPath = path.join(sysGenDir, "swarm", "members.json");
  try {
    const data = JSON.parse(fs.readFileSync(membersPath, "utf8"));
    const members = data?.members && typeof data.members === "object" ? Object.values(data.members) : [];
    for (const m of members) {
      if (!m || typeof m !== "object") continue;
      if (m.killed) {
        if (typeof m.conversation_id === "string") killedConvIds.add(m.conversation_id);
        continue;
      }
      if (m.role === "coordinator") continue;
      if (
        m.phase === "RUNNING" ||
        m.desired_state === "RUNNING" ||
        m.wake_mode === "working" ||
        Number(m.last_nudged_seq) > Number(m.last_read_seq)
      ) {
        return true;
      }
    }
  } catch {}

  const subagentsDir = path.join(sysGenDir, "subagents");
  try {
    for (const file of fs.readdirSync(subagentsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const sub = JSON.parse(fs.readFileSync(path.join(subagentsDir, file), "utf8"));
        if (!sub || sub.state !== "SUBAGENT_STATE_ALIVE") continue;
        if (typeof sub.conversationId === "string" && killedConvIds.has(sub.conversationId)) continue;
        return true;
      } catch {}
    }
  } catch {}

  return false;
}

function splitMcpServers(mcpServers) {
  if (!Array.isArray(mcpServers)) return { piBridge: null, others: [] };
  let piBridge = null;
  const others = [];
  for (const s of mcpServers) {
    if (s && typeof s === "object" && s.type === "http" && s.name === "pi-bridge" && typeof s.url === "string") {
      piBridge = s;
    } else {
      others.push(s);
    }
  }
  return { piBridge, others };
}

function stripHopByHopHeaders(rawHeaders) {
  const out = {};
  const connTokens = new Set();
  if (typeof rawHeaders.connection === "string") {
    for (const tok of rawHeaders.connection.split(",")) {
      const t = tok.trim().toLowerCase();
      if (t) connTokens.add(t);
    }
  }
  for (const [k, v] of Object.entries(rawHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || connTokens.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function stableJson(val) {
  return JSON.stringify(val ?? null);
}

function connectSocketWithTimeout(sockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error("socket connect timeout"));
    }, timeoutMs);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Non-invasive probe: sends __holderControl:"ping" (never touches holder's activeClient or clientEpoch).
// Returns "dead" ONLY on ENOENT/ECONNREFUSED; returns "alive" whenever a listener accepts.
function probeHolderSocket(sockPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    let settled = false;
    let connected = false;
    let buf = Buffer.alloc(0);
    const done = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => done("alive"), timeoutMs);
    sock.once("connect", () => {
      connected = true;
      try {
        sock.write('{"__holderControl":"ping"}\n');
      } catch {
        done("alive");
      }
    });
    sock.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      done("alive");
    });
    sock.once("error", (err) => {
      if (!connected && err && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) {
        done("dead");
      } else {
        done("alive");
      }
    });
    sock.once("close", () => done(connected ? "alive" : "dead"));
  });
}

function killProcessGroup(pid, sig) {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, sig);
    else process.kill(pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

// ============================================================================
// Holder mode: owns one detached `agy acp` process group + direct MCP proxy.
// ============================================================================
function runHolder(holderArgs) {
  let bootSock = null;
  const agyExtraArgs = [];
  for (let i = 0; i < holderArgs.length; i++) {
    if (holderArgs[i] === "--boot-sock" && i + 1 < holderArgs.length) {
      bootSock = holderArgs[++i];
    } else if (holderArgs[i] === "--") {
      agyExtraArgs.push(...holderArgs.slice(i + 1));
      break;
    }
  }
  if (!bootSock) process.exit(64);

  try {
    ensureSecureHoldersDir();
    process.umask(0o077);
  } catch {
    process.exit(1);
  }

  process.on("SIGHUP", () => {});

  // Dedicated direct agent so HTTP_PROXY/setGlobalProxyFromEnv never hijacks 127.0.0.1 MCP calls.
  const directHttpAgent = new http.Agent({ keepAlive: false });
  const proxyToken = crypto.randomBytes(16).toString("hex");
  let proxyPort = 0;
  let upstreamMcp = null; // { url: string, headers: Array<{name, value}> }
  let hasMcpBridge = false;
  let otherMcpFingerprint = "[]";

  const mcpProxy = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${proxyToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Unauthorized MCP proxy request"}}');
      return;
    }
    if (!upstreamMcp?.url) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"Pi MCP bridge disconnected"}}');
      return;
    }
    let target;
    try {
      target = new URL(upstreamMcp.url);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32003,"message":"Invalid upstream MCP URL"}}');
      return;
    }

    const reqHeaders = stripHopByHopHeaders(req.headers);
    reqHeaders.host = target.host;
    if (Array.isArray(upstreamMcp.headers)) {
      for (const h of upstreamMcp.headers) {
        if (h && typeof h.name === "string" && typeof h.value === "string") {
          reqHeaders[h.name.toLowerCase()] = h.value;
        }
      }
    }

    const proxyReq = http.request(
      {
        agent: directHttpAgent,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: reqHeaders,
      },
      (proxyRes) => {
        const resHeaders = stripHopByHopHeaders(proxyRes.headers);
        res.writeHead(proxyRes.statusCode || 502, resHeaders);
        res.flushHeaders?.();
        proxyRes.pipe(res);
        proxyRes.on("error", () => res.destroy());
        res.on("close", () => {
          if (!proxyRes.complete) proxyRes.destroy();
        });
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32004,"message":"Upstream Pi MCP bridge unreachable"}}');
      } else {
        res.destroy();
      }
    });
    req.on("error", () => proxyReq.destroy());
    req.on("aborted", () => proxyReq.destroy());
    res.on("error", () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  // Put `agy acp` in its own session/process group so shutdown cleanly reaps descendants too.
  const child = spawn(
    AGY_REAL_BIN,
    ["acp", "--dangerously-skip-permissions", ...agyExtraArgs],
    { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => {});

  let currentSockPath = bootSock;
  let currentSockIno = null;
  let sessionId = null;
  let sessionCwd = null;
  let sessionOrigin = null; // "new" | "loaded"
  let apiKeyAuth = Boolean(process.env.GEMINI_API_KEY);
  let hasNormalPrompt = false;

  let inFlightPromptBackendId = null;
  let cancelSentForPromptId = null;
  let promptBarrierTimer = null;
  const queuedPrompts = []; // Array<{ sock, epoch, msg }>
  const pendingAgentRequests = []; // Queued permission requests while detached

  let cachedInitResult = null;
  let cachedSessionState = null;

  let activeClient = null;
  let clientEpoch = 0;
  let nextBackendId = 1;
  const pendingToAgent = new Map(); // backendId -> { frontId, epoch, method, params }

  let lastActiveAt = null;
  let pollTimer = null;
  let shuttingDown = false;
  let finalized = false;
  let shutdownCode = 0;
  let hardKillTimer = null;
  const evictWaiters = [];

  function writeToClient(sock, obj) {
    if (!sock || sock.destroyed || !sock.writable) return;
    try {
      sock.write(`${JSON.stringify(obj)}\n`);
    } catch {}
  }

  function writeToAgent(obj) {
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function removeOwnedSock() {
    if (!currentSockPath) return;
    const p = currentSockPath;
    const expectedIno = currentSockIno;
    currentSockPath = null;
    currentSockIno = null;
    try {
      if (expectedIno !== null) {
        const st = fs.lstatSync(p);
        if (st.ino !== expectedIno) return;
      }
      fs.unlinkSync(p);
    } catch {}
  }

  // Only called AFTER `child` has exited, guaranteeing SQLite is released
  // before the session socket disappears and before evict waiters are notified.
  function finalizeShutdown(code) {
    if (finalized) return;
    finalized = true;
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
    removeOwnedSock();
    try {
      ipcServer.close();
    } catch {}
    const waiters = evictWaiters.splice(0).filter((w) => w && !w.destroyed);
    if (activeClient && !activeClient.destroyed && !waiters.includes(activeClient)) {
      try {
        activeClient.end();
      } catch {}
    }
    if (waiters.length === 0) {
      process.exit(code);
      return;
    }
    let remaining = waiters.length;
    const exitNow = () => process.exit(code);
    const guard = setTimeout(exitNow, 250);
    guard.unref?.();
    const payload = `${JSON.stringify({ __holderEvicted: true })}\n`;
    for (const w of waiters) {
      try {
        w.end(payload, () => {
          if (--remaining <= 0) {
            clearTimeout(guard);
            exitNow();
          }
        });
      } catch {
        if (--remaining <= 0) {
          clearTimeout(guard);
          exitNow();
        }
      }
    }
  }

  // Keeps `ipcServer` open until `child` exits so concurrent probes/attaches observe `shutting_down`
  // instead of seeing ECONNREFUSED and opening a second `agy` while SQLite is still flushing.
  function shutdown(code = 0, evictSock = null, forceKill = false) {
    if (evictSock && !evictWaiters.includes(evictSock)) {
      evictWaiters.push(evictSock);
    }
    if (shuttingDown) {
      if (forceKill && child.exitCode === null && child.signalCode === null) {
        killProcessGroup(child.pid, "SIGKILL");
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        finalizeShutdown(shutdownCode);
      }
      return;
    }
    shuttingDown = true;
    shutdownCode = code;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (promptBarrierTimer) {
      clearTimeout(promptBarrierTimer);
      promptBarrierTimer = null;
    }
    for (const req of pendingAgentRequests.splice(0)) clearTimeout(req.timer);
    try {
      mcpProxy.close();
      mcpProxy.closeAllConnections?.();
      directHttpAgent.destroy();
    } catch {}
    if (activeClient && !activeClient.destroyed && !evictWaiters.includes(activeClient)) {
      try {
        activeClient.end();
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end();
      } catch {}
      killProcessGroup(child.pid, forceKill ? "SIGKILL" : "SIGTERM");
      hardKillTimer = setTimeout(() => {
        hardKillTimer = null;
        killProcessGroup(child.pid, "SIGKILL");
      }, forceKill ? 500 : 1_500);
      hardKillTimer.unref?.();
    } else {
      finalizeShutdown(shutdownCode);
    }
  }

  // Atomically acquires `s-<newSessionId>.sock` via POSIX linkSync(EEXIST).
  // Returns true iff this holder exclusively owns the session socket; never unlinks a live holder.
  async function registerSessionSocket(newSessionId) {
    if (typeof newSessionId !== "string" || !UUID_RE.test(newSessionId)) return false;
    const target = sessionSocketPath(newSessionId);
    if (!target || !currentSockPath || shuttingDown) return false;
    if (sessionId === newSessionId && currentSockPath === target) return true;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!currentSockPath || shuttingDown) return false;
      try {
        fs.linkSync(currentSockPath, target);
        const oldSock = currentSockPath;
        currentSockPath = target;
        sessionId = newSessionId;
        try {
          currentSockIno = fs.lstatSync(target).ino;
        } catch {}
        if (oldSock !== target) {
          try {
            fs.unlinkSync(oldSock);
          } catch {}
        }
        return true;
      } catch (err) {
        if (!err || err.code !== "EEXIST") return false;
        const status = await probeHolderSocket(target);
        if (status === "alive") {
          return false;
        }
        try {
          fs.unlinkSync(target);
        } catch {}
      }
    }
    return false;
  }

  function rewriteMcpServersForAgent(params) {
    if (!params || !Array.isArray(params.mcpServers)) {
      upstreamMcp = null;
      hasMcpBridge = false;
      otherMcpFingerprint = "[]";
      return params;
    }
    const { piBridge, others } = splitMcpServers(params.mcpServers);
    otherMcpFingerprint = stableJson(others);
    if (!piBridge || !proxyPort) {
      upstreamMcp = null;
      hasMcpBridge = false;
      return params;
    }
    upstreamMcp = { url: piBridge.url, headers: piBridge.headers };
    hasMcpBridge = true;
    const proxied = {
      type: "http",
      name: "pi-bridge",
      url: `http://127.0.0.1:${proxyPort}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${proxyToken}` }],
    };
    return { ...params, mcpServers: [...others, proxied] };
  }

  function syncModeSelectorInConfigOptions(configOptions, modeId) {
    if (!Array.isArray(configOptions) || typeof modeId !== "string") return configOptions;
    let changed = false;
    const next = configOptions.map((opt) => {
      if (opt && typeof opt === "object" && (opt.category === "mode" || opt.id === "mode")) {
        changed = true;
        return { ...opt, currentValue: modeId };
      }
      return opt;
    });
    return changed ? next : configOptions;
  }

  function isCompleteConfigOption(opt) {
    if (!opt || typeof opt !== "object" || typeof opt.id !== "string") return false;
    if (opt.type === "boolean") return typeof opt.currentValue === "boolean";
    if (opt.type === "select") return typeof opt.currentValue === "string" && Array.isArray(opt.options);
    return false;
  }

  // Matches connection.ts updateSessionState semantics for valid ACP configOptions arrays
  // (including shrinking when switching to a model without thought_level), while patching by id
  // if a partial delta omits `type`/`options`.
  function applyConfigOptions(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    if (!Array.isArray(existing)) return incoming;
    if (incoming.every(isCompleteConfigOption)) {
      return incoming;
    }
    const byId = new Map();
    const order = [];
    for (const opt of existing) {
      if (opt && typeof opt === "object" && typeof opt.id === "string") {
        byId.set(opt.id, opt);
        order.push(opt.id);
      }
    }
    for (const opt of incoming) {
      if (!opt || typeof opt !== "object" || typeof opt.id !== "string") continue;
      if (byId.has(opt.id)) {
        byId.set(opt.id, { ...byId.get(opt.id), ...opt });
      } else {
        byId.set(opt.id, opt);
        order.push(opt.id);
      }
    }
    return order.map((id) => byId.get(id));
  }

  function updateCachedSessionStateFromUpdate(update) {
    if (!cachedSessionState || !update || typeof update !== "object") return;
    if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
      const next = { ...cachedSessionState };
      if (next.modes && typeof next.modes === "object") {
        next.modes = { ...next.modes, currentModeId: update.currentModeId };
      }
      if (Array.isArray(next.configOptions)) {
        next.configOptions = syncModeSelectorInConfigOptions(next.configOptions, update.currentModeId);
      }
      cachedSessionState = next;
    } else if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      cachedSessionState = {
        ...cachedSessionState,
        configOptions: applyConfigOptions(cachedSessionState.configOptions, update.configOptions),
      };
    }
  }

  function updateCachedSessionStateFromResponse(method, params, result) {
    if (!result || typeof result !== "object") return;
    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      cachedSessionState = { ...result };
      delete cachedSessionState.sessionId;
      return;
    }
    if (!cachedSessionState) return;
    if (method === "session/set_config_option") {
      if (Array.isArray(result.configOptions)) {
        cachedSessionState = {
          ...cachedSessionState,
          configOptions: applyConfigOptions(cachedSessionState.configOptions, result.configOptions),
        };
      } else if (Array.isArray(cachedSessionState.configOptions) && typeof params?.configId === "string" && params?.value !== undefined) {
        cachedSessionState = {
          ...cachedSessionState,
          configOptions: cachedSessionState.configOptions.map((opt) =>
            opt && opt.id === params.configId ? { ...opt, currentValue: params.value } : opt,
          ),
        };
      }
    } else if (method === "session/set_mode" && typeof params?.modeId === "string") {
      const next = { ...cachedSessionState };
      if (next.modes && typeof next.modes === "object") {
        next.modes = { ...next.modes, currentModeId: params.modeId };
      }
      if (Array.isArray(next.configOptions)) {
        next.configOptions = syncModeSelectorInConfigOptions(next.configOptions, params.modeId);
      }
      cachedSessionState = next;
    } else if (method === "session/set_model" && typeof params?.modelId === "string" && cachedSessionState.models) {
      cachedSessionState = {
        ...cachedSessionState,
        models: { ...cachedSessionState.models, currentModelId: params.modelId },
      };
    }
  }

  function cancelInFlightPromptIfNeeded() {
    if (inFlightPromptBackendId === null || !sessionId) return;
    if (cancelSentForPromptId === inFlightPromptBackendId) return;
    cancelSentForPromptId = inFlightPromptBackendId;
    writeToAgent({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    if (promptBarrierTimer) clearTimeout(promptBarrierTimer);
    const trackedId = inFlightPromptBackendId;
    promptBarrierTimer = setTimeout(() => {
      promptBarrierTimer = null;
      if (inFlightPromptBackendId === trackedId) {
        // Never overlap a new session/prompt on top of an unsettled cancelled prompt.
        for (const q of queuedPrompts.splice(0)) {
          if (q.sock === activeClient && q.epoch === clientEpoch && !q.sock.destroyed) {
            writeToClient(q.sock, {
              jsonrpc: "2.0",
              id: q.msg.id,
              error: { code: -32007, message: "Previous prompt cancellation did not settle in time" },
            });
          }
        }
      }
    }, PROMPT_BARRIER_MS);
    promptBarrierTimer.unref?.();
  }

  function flushQueuedPrompts() {
    if (inFlightPromptBackendId !== null) return;
    while (queuedPrompts.length > 0) {
      const next = queuedPrompts.shift();
      if (next.sock !== activeClient || next.epoch !== clientEpoch || next.sock.destroyed) {
        continue;
      }
      void dispatchClientRequestToAgent(next.sock, next.epoch, next.msg);
      return;
    }
  }

  function flushPendingAgentRequests() {
    if (!activeClient || activeClient.destroyed) return;
    for (const req of pendingAgentRequests.splice(0)) {
      clearTimeout(req.timer);
      writeToClient(activeClient, req.msg);
    }
  }

  function promoteActiveClient(sock) {
    if (activeClient && activeClient !== sock) {
      cancelInFlightPromptIfNeeded();
      try {
        activeClient.destroy();
      } catch {}
    }
    const epoch = ++clientEpoch;
    activeClient = sock;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    lastActiveAt = null;
    return epoch;
  }

  function checkDetachLifecycle() {
    if (activeClient || shuttingDown) return;
    const now = Date.now();
    if (lastActiveAt === null) lastActiveAt = now;
    if (!hasNormalPrompt) {
      shutdown(0);
      return;
    }
    if (hasActiveBackgroundWork(sessionId, child.pid)) {
      lastActiveAt = now;
      return;
    }
    if (now - lastActiveAt >= HOLDER_GRACE_MS) {
      shutdown(0);
    }
  }

  function onClientDisconnected(sock) {
    if (activeClient !== sock) return;
    activeClient = null;
    upstreamMcp = null;
    cancelInFlightPromptIfNeeded();
    if (!hasNormalPrompt) {
      shutdown(0);
      return;
    }
    lastActiveAt = Date.now();
    if (!pollTimer) {
      pollTimer = setInterval(checkDetachLifecycle, HOLDER_POLL_MS);
    }
    if (HOLDER_GRACE_MS === 0 && !hasActiveBackgroundWork(sessionId, child.pid)) {
      shutdown(0);
    }
  }

  async function dispatchClientRequestToAgent(sock, epoch, msg) {
    const method = msg.method;
    let params = msg.params;

    if (method === "authenticate" && params?._meta?.["api-key"]) {
      apiKeyAuth = true;
    } else if (method === "session/load" || method === "session/resume") {
      if (typeof params?.sessionId === "string") {
        const acquired = await registerSessionSocket(params.sessionId);
        if (shuttingDown || sock !== activeClient || epoch !== clientEpoch) return;
        if (!acquired) {
          writeToClient(sock, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32006, message: "Session is already owned by another live holder" },
          });
          return;
        }
      }
      sessionOrigin = "loaded";
      if (typeof params?.cwd === "string") sessionCwd = params.cwd;
      params = rewriteMcpServersForAgent(params);
    } else if (method === "session/new") {
      sessionOrigin = "new";
      if (typeof params?.cwd === "string") sessionCwd = params.cwd;
      params = rewriteMcpServersForAgent(params);
    } else if (method === "session/prompt") {
      hasNormalPrompt = true;
    }

    if (shuttingDown || sock !== activeClient || epoch !== clientEpoch) return;

    const backendId = nextBackendId++;
    pendingToAgent.set(backendId, { frontId: msg.id, epoch, method, params: msg.params });
    if (method === "session/prompt") {
      inFlightPromptBackendId = backendId;
      cancelSentForPromptId = null;
    }
    const ok = writeToAgent({ ...msg, id: backendId, params });
    if (!ok) {
      pendingToAgent.delete(backendId);
      if (inFlightPromptBackendId === backendId) {
        inFlightPromptBackendId = null;
        cancelSentForPromptId = null;
      }
      writeToClient(sock, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Antigravity ACP agent stdin closed" },
      });
    }
  }

  async function forwardFromClient(sock, epoch, msg) {
    if (msg.__holderControl === "shutdown_for_usage") {
      if (
        sock === activeClient &&
        epoch === clientEpoch &&
        sessionOrigin === "new" &&
        !hasNormalPrompt &&
        !hasActiveBackgroundWork(sessionId, child.pid)
      ) {
        shutdown(0, sock, true);
      } else {
        writeToClient(sock, { __holderEvicted: false, reason: "refused" });
      }
      return;
    }

    // Strict ownership check: ignore any buffered frames from replaced/stale sockets.
    if (sock !== activeClient || epoch !== clientEpoch) return;

    // Client response to an agent-initiated request or client notification.
    if (msg.method === undefined || msg.id === undefined) {
      writeToAgent(msg);
      return;
    }

    // Barrier: queue new session/prompt until any prior cancelled/in-flight prompt settles.
    if (msg.method === "session/prompt" && inFlightPromptBackendId !== null) {
      queuedPrompts.push({ sock, epoch, msg });
      return;
    }

    await dispatchClientRequestToAgent(sock, epoch, msg);
  }

  attachLineReader(child.stdout, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Response from agent to a client request.
    if (msg.method === undefined && msg.id !== undefined) {
      const entry = pendingToAgent.get(msg.id);
      if (!entry) return;
      pendingToAgent.delete(msg.id);

      const wasInFlightPrompt = inFlightPromptBackendId === msg.id;
      if (wasInFlightPrompt) {
        inFlightPromptBackendId = null;
        cancelSentForPromptId = null;
        if (promptBarrierTimer) {
          clearTimeout(promptBarrierTimer);
          promptBarrierTimer = null;
        }
      }

      if (msg.result && typeof msg.result === "object") {
        if (entry.method === "initialize" && msg.result.agentCapabilities) {
          msg.result.agentCapabilities.mcpCapabilities ??= { http: true };
          cachedInitResult = msg.result;
          writeInitCache(cachedInitResult);
        } else if (entry.method === "session/new") {
          if (typeof msg.result.sessionId === "string") {
            // New UUIDv4: linkSync succeeds synchronously on first iteration.
            void registerSessionSocket(msg.result.sessionId);
          }
          updateCachedSessionStateFromResponse(entry.method, entry.params, msg.result);
        } else {
          updateCachedSessionStateFromResponse(entry.method, entry.params, msg.result);
        }
      }

      if (activeClient && entry.epoch === clientEpoch) {
        writeToClient(activeClient, { ...msg, id: entry.frontId });
      }
      if (wasInFlightPrompt) {
        flushQueuedPrompts();
      }
      return;
    }

    // Notification from agent.
    if (msg.id === undefined) {
      if (msg.method === "session/update") {
        updateCachedSessionStateFromUpdate(msg.params?.update);
      }
      if (activeClient) writeToClient(activeClient, msg);
      return;
    }

    // Agent -> Client request (e.g. session/request_permission).
    if (activeClient) {
      writeToClient(activeClient, msg);
    } else if (msg.method === "session/request_permission") {
      const entry = {
        msg,
        timer: setTimeout(() => {
          const idx = pendingAgentRequests.indexOf(entry);
          if (idx >= 0) pendingAgentRequests.splice(idx, 1);
          writeToAgent({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
        }, PERMISSION_QUEUE_MS),
      };
      entry.timer.unref?.();
      pendingAgentRequests.push(entry);
    } else {
      writeToAgent({ jsonrpc: "2.0", id: msg.id, error: { code: -32005, message: "No attached ACP client" } });
    }
  });

  child.stderr.on("data", (chunk) => {
    if (activeClient && !activeClient.destroyed && activeClient.writable) {
      writeToClient(activeClient, { __holderStderr: chunk.toString("base64") });
    }
  });

  child.on("error", (err) => {
    if (activeClient) {
      writeToClient(activeClient, { __holderStderr: Buffer.from(`agy-acp holder: ${err.message}\n`).toString("base64") });
    }
    shutdown(1);
  });
  child.on("close", (code, sig) => {
    if (shuttingDown) {
      finalizeShutdown(shutdownCode);
    } else {
      shutdown(code ?? (sig ? 1 : 0));
    }
  });

  const ipcServer = net.createServer((sock) => {
    // Do NOT bump clientEpoch on TCP accept: probes and rejected attaches must never disturb activeClient.
    let sockEpoch = null;
    let sockQueue = Promise.resolve();

    attachLineReader(sock, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.__holderControl === "ping") {
        writeToClient(sock, { __holderPong: true, sessionId, shuttingDown });
        sock.end();
        return;
      }

      if (msg.__holderControl === "evict") {
        shutdown(0, sock, false);
        return;
      }

      if (msg.__holderControl === "attach") {
        if (shuttingDown) {
          writeToClient(sock, { __holderAttachOk: false, reason: "shutting_down" });
          sock.end();
          return;
        }
        if (!sessionId || cachedSessionState === null) {
          writeToClient(sock, { __holderAttachOk: false, reason: "initializing" });
          sock.end();
          return;
        }
        const req = msg.request;
        const reqParams = req?.params || {};
        const { piBridge, others } = splitMcpServers(reqParams.mcpServers);
        const compatible =
          reqParams.sessionId === sessionId &&
          reqParams.cwd === sessionCwd &&
          Boolean(piBridge) === hasMcpBridge &&
          stableJson(others) === otherMcpFingerprint &&
          Boolean(msg.apiKeyAuth) === apiKeyAuth;

        if (!compatible) {
          writeToClient(sock, { __holderAttachOk: false, reason: "incompatible" });
          sock.end();
          return;
        }

        sockEpoch = promoteActiveClient(sock);
        upstreamMcp = piBridge ? { url: piBridge.url, headers: piBridge.headers } : null;
        writeToClient(sock, {
          __holderAttachOk: true,
          response: { jsonrpc: "2.0", id: req.id, result: cachedSessionState },
        });
        flushPendingAgentRequests();
        return;
      }

      if (sockEpoch === null) {
        if (shuttingDown) {
          sock.end();
          return;
        }
        sockEpoch = promoteActiveClient(sock);
      }

      const epoch = sockEpoch;
      sockQueue = sockQueue.then(() => forwardFromClient(sock, epoch, msg)).catch(() => {});
    });

    sock.on("error", () => onClientDisconnected(sock));
    sock.on("close", () => onClientDisconnected(sock));
  });

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => shutdown(0));
  }

  mcpProxy.listen(0, "127.0.0.1", () => {
    const addr = mcpProxy.address();
    proxyPort = addr && typeof addr !== "string" ? addr.port : 0;
    try {
      fs.unlinkSync(bootSock);
    } catch {}
    ipcServer.listen(bootSock, () => {
      try {
        fs.chmodSync(bootSock, 0o600);
        currentSockIno = fs.lstatSync(bootSock).ino;
      } catch {}
    });
  });
  ipcServer.on("error", () => shutdown(1));
  mcpProxy.on("error", () => shutdown(1));
}

// ============================================================================
// Direct legacy mode (fallback when AGY_ACP_DISABLE_HOLDER=1 or unsafe tmpdir).
// ============================================================================
function runDirect(args) {
  const child = spawn(
    AGY_REAL_BIN,
    ["acp", "--dangerously-skip-permissions", ...args],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") child.kill("SIGTERM");
  });
  child.stdin.on("error", () => {});

  let sessionOrigin = null;
  let hasIssuedNormalPrompt = false;
  let usageSessionId = null;
  let handlingUsage = false;
  let initPatched = false;
  let apiKeyAuth = Boolean(process.env.GEMINI_API_KEY);

  attachLineReader(child.stdout, (line) => {
    if (!initPatched && line.includes('"agentCapabilities"')) {
      try {
        const msg = JSON.parse(line);
        if (msg?.result?.agentCapabilities) {
          msg.result.agentCapabilities.mcpCapabilities ??= { http: true };
          initPatched = true;
          process.stdout.write(`${JSON.stringify(msg)}\n`);
          return;
        }
      } catch {}
    }
    process.stdout.write(`${line}\n`);
  });

  attachLineReader(process.stdin, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`);
      return;
    }
    if (msg?.method === "authenticate" && msg?.params?._meta?.["api-key"]) {
      apiKeyAuth = true;
    } else if (msg?.method === "session/new") {
      sessionOrigin = "new";
    } else if (msg?.method === "session/load" || msg?.method === "session/resume") {
      sessionOrigin = "loaded";
    } else if (msg?.method === "session/prompt") {
      const usageArgs = parseUsageArgs(msg.params?.prompt);
      if (
        usageArgs !== null &&
        sessionOrigin === "new" &&
        !hasIssuedNormalPrompt &&
        !hasActiveBackgroundWork(msg.params?.sessionId, child.pid)
      ) {
        const sessionId = msg.params?.sessionId;
        const reqId = msg.id;
        handlingUsage = true;
        usageSessionId = sessionId;
        void (async () => {
          const text = usageArgs ? `/usage takes no arguments, got ${JSON.stringify(usageArgs)}` : await buildQuotaMarkdown(apiKeyAuth);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await new Promise((r) => child.once("close", r));
          }
          removeUsageConversation(sessionId);
          usageSessionId = null;
          if (process.stdout.destroyed || process.stdout.writableEnded) return;
          process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
          })}\n`);
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { stopReason: "end_turn" } })}\n`);
        })();
        return;
      }
      hasIssuedNormalPrompt = true;
      usageSessionId = null;
    }
    child.stdin.write(`${line}\n`);
  });

  process.stdin.once("end", () => {
    if (!handlingUsage) child.stdin.end();
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (handlingUsage) {
        if (usageSessionId && (child.exitCode !== null || child.signalCode !== null)) {
          removeUsageConversation(usageSessionId);
        }
        exitCleanly(0);
        return;
      }
      child.kill(sig);
    });
  }
  child.on("error", (err) => {
    process.stderr.write(`agy-acp wrapper: ${err.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, sig) => {
    if (handlingUsage) return;
    if (usageSessionId) removeUsageConversation(usageSessionId);
    exitCleanly(code ?? (sig ? 1 : 0));
  });
}

// ============================================================================
// Frontend mode: enforces single-owner attach/evict before any cold load.
// ============================================================================
async function spawnFreshHolder(extraArgs) {
  const dir = ensureSecureHoldersDir();
  const bootSock = path.join(dir, `boot-${process.pid}-${crypto.randomBytes(6).toString("hex")}.sock`);
  const holder = spawn(
    process.execPath,
    [__filename, "--holder", "--boot-sock", bootSock, "--", ...extraArgs],
    { detached: true, stdio: "ignore", env: process.env },
  );
  let holderExited = false;
  let holderExitInfo = "";
  holder.once("exit", (code, sig) => {
    holderExited = true;
    holderExitInfo = `code=${code} sig=${sig}`;
  });
  holder.unref();

  const deadline = Date.now() + 10_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (holderExited) {
      throw new Error(`agy-acp holder exited early (${holderExitInfo})`);
    }
    try {
      return await connectSocketWithTimeout(bootSock, 500);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw lastErr || new Error("Timed out waiting for agy-acp holder socket");
}

function tryAttachWarmHolder(sessionId, requestMsg, apiKeyAuth) {
  const sockPath = sessionSocketPath(sessionId);
  if (!sockPath || !fs.existsSync(sockPath)) return Promise.resolve({ status: "none" });
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.status !== "attached" && sock && !sock.destroyed) sock.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "timeout", sockPath }), ATTACH_TIMEOUT_MS);

    connectSocketWithTimeout(sockPath, ATTACH_TIMEOUT_MS)
      .then((s) => {
        if (settled) {
          s.destroy();
          return;
        }
        sock = s;
        let buf = Buffer.alloc(0);
        const onData = (chunk) => {
          buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const firstLine = buf.subarray(0, nl).toString("utf8");
          const remainder = buf.subarray(nl + 1);
          sock.off("data", onData);
          sock.off("error", onErr);
          sock.off("close", onClose);
          try {
            const reply = JSON.parse(firstLine);
            if (reply?.__holderAttachOk && reply.response) {
              finish({ status: "attached", sock, response: reply.response, remainder });
              return;
            }
            if (reply?.__holderAttachOk === false) {
              finish({ status: "rejected", reason: reply.reason || "incompatible", sockPath });
              return;
            }
          } catch {}
          finish({ status: "timeout", sockPath });
        };
        const onErr = () => finish({ status: "timeout", sockPath });
        const onClose = () => finish({ status: "timeout", sockPath });
        sock.on("data", onData);
        sock.once("error", onErr);
        sock.once("close", onClose);
        sock.write(`${JSON.stringify({ __holderControl: "attach", request: requestMsg, apiKeyAuth })}\n`);
      })
      .catch((err) => {
        if (err && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
          try {
            fs.unlinkSync(sockPath);
          } catch {}
          finish({ status: "none" });
          return;
        }
        finish({ status: "timeout", sockPath });
      });
  });
}

// Requests a live incompatible/shutting-down holder to exit cleanly and verifies its socket is dead.
async function evictWarmHolder(sockPath, timeoutMs = EVICT_TIMEOUT_MS) {
  await new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock && !sock.destroyed) sock.destroy();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    connectSocketWithTimeout(sockPath, Math.min(timeoutMs, 1_000))
      .then((s) => {
        if (settled) {
          s.destroy();
          return;
        }
        sock = s;
        let buf = Buffer.alloc(0);
        sock.on("data", (chunk) => {
          buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
          if (buf.indexOf(0x0a) >= 0) done();
        });
        sock.once("error", done);
        sock.once("close", done);
        sock.write('{"__holderControl":"evict"}\n');
      })
      .catch(done);
  });

  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(sockPath)) return true;
    const status = await probeHolderSocket(sockPath, 300);
    if (status === "dead") {
      try {
        fs.unlinkSync(sockPath);
      } catch {}
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return !fs.existsSync(sockPath);
}

function runFrontend(args) {
  try {
    ensureSecureHoldersDir();
  } catch (err) {
    process.stderr.write(`agy-acp wrapper: ${err instanceof Error ? err.message : String(err)}; falling back to direct mode\n`);
    runDirect(args);
    return;
  }

  const deferredInitCache = hasAnySessionSocket() ? readValidInitCache() : null;
  let deferredInitReq = null;
  let swallowInitId = null;
  let resolveSwallowedInit = null;

  let holderSock = null;
  let boundSession = false;
  let sessionOrigin = null; // "new" | "loaded"
  let hasIssuedNormalPrompt = false;
  let apiKeyAuth = Boolean(process.env.GEMINI_API_KEY);
  let handlingUsage = false;
  let usageSessionId = null;
  let stdinQueue = Promise.resolve();

  function writeStdout(obj) {
    if (process.stdout.destroyed || process.stdout.writableEnded) return;
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  function handleHolderLine(sock, line) {
    if (holderSock !== sock) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.__holderEvicted !== undefined) return;
    if (typeof msg.__holderStderr === "string") {
      try {
        process.stderr.write(Buffer.from(msg.__holderStderr, "base64"));
      } catch {}
      return;
    }
    if (swallowInitId !== null && msg.method === undefined && msg.id === swallowInitId) {
      swallowInitId = null;
      const done = resolveSwallowedInit;
      resolveSwallowedInit = null;
      done?.(msg);
      return;
    }
    writeStdout(msg);
  }

  function bindHolderSocket(sock, remainder) {
    holderSock = sock;
    attachLineReader(sock, (line) => handleHolderLine(sock, line));
    if (remainder && remainder.length) {
      sock.emit("data", remainder);
    }
    sock.on("error", () => {
      if (holderSock !== sock) return;
      resolveSwallowedInit?.(null);
      resolveSwallowedInit = null;
      if (!handlingUsage) exitCleanly(1);
    });
    sock.on("close", () => {
      if (holderSock !== sock) return;
      resolveSwallowedInit?.(null);
      resolveSwallowedInit = null;
      if (!handlingUsage) exitCleanly(0);
    });
  }

  function discardUnusedColdHolder() {
    if (!holderSock) return;
    const old = holderSock;
    holderSock = null;
    try {
      old.destroy();
    } catch {}
  }

  async function ensureColdHolder() {
    if (holderSock) return;
    const sock = await spawnFreshHolder(args);
    bindHolderSocket(sock, null);
    if (deferredInitReq) {
      const req = deferredInitReq;
      deferredInitReq = null;
      swallowInitId = req.id;
      const initDone = new Promise((resolve) => {
        resolveSwallowedInit = resolve;
      });
      sock.write(`${JSON.stringify(req)}\n`);
      await Promise.race([initDone, new Promise((r) => setTimeout(r, 10_000))]);
    }
  }

  async function processClientLine(line) {
    if (handlingUsage) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg?.method === "authenticate" && msg?.params?._meta?.["api-key"]) {
      apiKeyAuth = true;
    }

    // Standalone /usage fast path ONLY on fresh `session/new` sessions with no normal prompt and no background work.
    if (msg?.method === "session/prompt") {
      const usageArgs = parseUsageArgs(msg.params?.prompt);
      if (
        usageArgs !== null &&
        sessionOrigin === "new" &&
        !hasIssuedNormalPrompt &&
        !hasActiveBackgroundWork(msg.params?.sessionId, 0)
      ) {
        const sessionId = msg.params?.sessionId;
        const reqId = msg.id;
        handlingUsage = true;
        usageSessionId = sessionId;
        const text = usageArgs
          ? `/usage takes no arguments, got ${JSON.stringify(usageArgs)}`
          : await buildQuotaMarkdown(apiKeyAuth);
        let holderEvicted = true;
        if (holderSock && !holderSock.destroyed) {
          const old = holderSock;
          holderSock = null;
          holderEvicted = await new Promise((resolve) => {
            let done = false;
            let buf = Buffer.alloc(0);
            const finish = (ok) => {
              if (done) return;
              done = true;
              clearTimeout(t);
              try {
                old.destroy();
              } catch {}
              resolve(ok);
            };
            const t = setTimeout(() => finish(false), 2_000);
            old.on("data", (chunk) => {
              buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
              let nl;
              while ((nl = buf.indexOf(0x0a)) >= 0) {
                const l = buf.subarray(0, nl).toString("utf8");
                buf = buf.subarray(nl + 1);
                try {
                  const r = JSON.parse(l);
                  if (typeof r.__holderEvicted === "boolean") {
                    finish(r.__holderEvicted);
                    return;
                  }
                } catch {}
              }
            });
            old.once("close", () => finish(true));
            old.once("error", () => finish(false));
            try {
              old.write(`${JSON.stringify({ __holderControl: "shutdown_for_usage" })}\n`);
            } catch {
              finish(false);
            }
          });
        }
        if (holderEvicted) removeUsageConversation(sessionId);
        usageSessionId = null;
        writeStdout({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
        });
        writeStdout({ jsonrpc: "2.0", id: reqId, result: { stopReason: "end_turn" } });
        handlingUsage = false;
        return;
      }
      hasIssuedNormalPrompt = true;
      usageSessionId = null;
    }

    // Defer spawning a cold holder on `initialize` when a warm cache is available.
    // (`authenticate` is intentionally NOT faked so verifyApiKey / interactive OAuth run against real agy;
    //  any resulting unused cold holder is discarded below if the subsequent session/load attaches warm.)
    if (!boundSession && !holderSock && msg?.method === "initialize" && msg.id !== undefined && deferredInitCache) {
      deferredInitReq = msg;
      writeStdout({ jsonrpc: "2.0", id: msg.id, result: deferredInitCache });
      return;
    }

    // On ANY session/load or session/resume, enforce single-owner warm attach or clean eviction before cold load.
    if (!boundSession && (msg?.method === "session/load" || msg?.method === "session/resume") && typeof msg?.params?.sessionId === "string") {
      let res = await tryAttachWarmHolder(msg.params.sessionId, msg, apiKeyAuth);
      for (let retry = 0; retry < 4 && res.status === "rejected" && res.reason === "initializing"; retry++) {
        await new Promise((r) => setTimeout(r, 250));
        res = await tryAttachWarmHolder(msg.params.sessionId, msg, apiKeyAuth);
      }

      if (res.status === "attached") {
        discardUnusedColdHolder();
        boundSession = true;
        sessionOrigin = "loaded";
        deferredInitReq = null;
        bindHolderSocket(res.sock, res.remainder);
        writeStdout(res.response);
        return;
      }

      if (res.status === "rejected" && (res.reason === "incompatible" || res.reason === "shutting_down")) {
        const evicted = await evictWarmHolder(res.sockPath, EVICT_TIMEOUT_MS);
        if (!evicted) {
          writeStdout({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32006, message: "Existing session holder could not be evicted cleanly" },
          });
          return;
        }
      } else if (res.status !== "none") {
        // Timeout or still initializing: never double-open SQLite while socket is alive.
        const aliveStatus = res.sockPath ? await probeHolderSocket(res.sockPath, 300) : "dead";
        if (aliveStatus === "alive") {
          writeStdout({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32006, message: "Existing session holder is still active or unresponsive" },
          });
          return;
        }
        if (res.sockPath) {
          try {
            fs.unlinkSync(res.sockPath);
          } catch {}
        }
      }
    }

    if (msg?.method === "session/new") {
      boundSession = true;
      sessionOrigin = "new";
    } else if (msg?.method === "session/load" || msg?.method === "session/resume") {
      boundSession = true;
      sessionOrigin = "loaded";
    }

    await ensureColdHolder();
    holderSock.write(`${JSON.stringify(msg)}\n`);
  }

  attachLineReader(process.stdin, (line) => {
    stdinQueue = stdinQueue
      .then(() => processClientLine(line))
      .catch((err) => {
        process.stderr.write(`agy-acp wrapper: ${err instanceof Error ? err.message : String(err)}\n`);
        exitCleanly(1);
      });
  });

  process.stdin.once("end", () => {
    if (handlingUsage) return;
    void stdinQueue.finally(() => {
      if (holderSock && !holderSock.destroyed) holderSock.end();
      exitCleanly(0);
    });
  });

  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") {
      if (holderSock && !holderSock.destroyed) holderSock.destroy();
      process.exit(0);
    }
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (handlingUsage) {
        if (usageSessionId && !holderSock) removeUsageConversation(usageSessionId);
        exitCleanly(0);
        return;
      }
      if (holderSock && !holderSock.destroyed) holderSock.destroy();
      process.exit(0);
    });
  }
}

// ============================================================================
// Entrypoint
// ============================================================================
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--holder") {
  runHolder(rawArgs.slice(1));
} else {
  syncLegacyAuthMarker();
  const passthrough = rawArgs.some((a) => a === "-h" || a === "--help" || a === "--login");
  if (passthrough) {
    const child = spawn(AGY_REAL_BIN, ["acp", "--dangerously-skip-permissions", ...rawArgs], { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(sig, () => child.kill(sig));
    }
    child.on("error", (err) => {
      process.stderr.write(`agy-acp wrapper: ${err.message}\n`);
      process.exit(1);
    });
    child.on("close", (code, sig) => exitCleanly(code ?? (sig ? 1 : 0)));
  } else if (HOLDER_DISABLED) {
    runDirect(rawArgs);
  } else {
    runFrontend(rawArgs);
  }
}
