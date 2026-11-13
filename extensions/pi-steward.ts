import type { ExtensionAPI, PackageSource } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODULE_DIR =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function resolveDefaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export interface CanonSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  enabledModels?: string[];
  packages?: PackageSource[];
  theme?: string;
  tuiMode?: "fullscreen" | "regular";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  doubleEscapeAction?: "fork" | "tree" | "none";
  quietStartup?: boolean | "header";
  [key: string]: unknown;
}

export interface MachineMarker {
  machineId?: string;
  hubRepoPath?: string;
  defaultProvider?: string;
  defaultModel?: string;
  lastSyncedCanonPackages?: string[];
  lastSyncedCanonModels?: string[];
}

export interface StewardSyncState {
  lastSyncedCanonPackages?: string[];
  lastSyncedCanonModels?: string[];
  lastSyncedCanonSettingKeys?: string[];
}

export type FileSyncPolicy = "overwrite" | "seed-if-missing" | "seed-if-empty";

export interface ManagedFileDiff {
  targetName: string;
  sourcePath: string;
  targetPath: string;
  policy: FileSyncPolicy;
  changed: boolean;
  customized: boolean;
  backupOnInitialTakeover?: boolean;
  nextContent?: string;
}

export interface StewardDiff {
  mode: "writable-clone" | "read-only-sync";
  machineId: string | undefined;
  activeRepoRoot: string;
  hubRepoPath: string | undefined;
  settingsChanged: boolean;
  fileChanges: ManagedFileDiff[];
  hasContentChanges: boolean;
  syncStateChanged: boolean;
  mergedSettings: CanonSettings;
  nextSyncState: StewardSyncState;
  incubatingPackages: string[];
}

const SYNC_STATE_FILENAME = ".pi-steward-state.json";

export function isOfflineModeEnabled(): boolean {
  const value = process.env.PI_OFFLINE;
  if (!value) return false;
  const lower = value.toLowerCase();
  return value === "1" || lower === "true" || lower === "yes";
}

function getSafeMachineId(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    return undefined;
  }
  return trimmed;
}

function getGitExecutable(): string {
  if (process.platform !== "win32" && fs.existsSync("/usr/bin/git")) {
    return "/usr/bin/git";
  }
  return "git";
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function shortenHome(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) {
    return "~" + p.slice(home.length).replace(/\\/g, "/");
  }
  return p;
}

export function formatShortPackageName(entry: PackageSource): string {
  const raw = (typeof entry === "string" ? entry : entry.source).trim();
  if (raw.startsWith("npm:")) {
    const spec = raw.slice(4).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
    return match?.[1] ?? spec;
  }
  if (raw.startsWith("git:") || /^(https?|ssh|git):\/\//i.test(raw) || /^git@[^/:]+:.+/.test(raw)) {
    const withoutPrefix = raw.startsWith("git:") ? raw.slice(4).trim() : raw;
    const withoutHash = (withoutPrefix.split("#")[0] ?? withoutPrefix).replace(/\/+$/g, "").replace(/\.git$/i, "");
    const { repo } = splitGitRef(withoutHash);
    const tail = repo.split(/[/:]/).filter(Boolean).pop();
    return tail || raw;
  }
  const cleaned = raw.replace(/[\\/]+$/g, "");
  const base = path.basename(cleaned);
  return base || shortenHome(raw);
}

export interface HubGitSummary {
  dirtyCount: number;
  aheadCount: number;
  behindCount: number;
  cacheMismatch: boolean;
  cacheMatchesUpstream?: boolean;
}

export async function inspectHubGitSummary(
  hubRepoPath: string | undefined,
  packageRepoRoot: string,
): Promise<HubGitSummary | undefined> {
  if (!hubRepoPath || !fs.existsSync(path.join(hubRepoPath, ".git"))) {
    return undefined;
  }
  const gitBin = getGitExecutable();
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  let dirtyCount = 0;
  let aheadCount = 0;
  let behindCount = 0;
  let cacheMismatch = false;
  let cacheMatchesUpstream = false;
  let upstreamHead = "";

  try {
    const { stdout } = await execFileAsync(gitBin, ["-C", hubRepoPath, "status", "--porcelain"], {
      timeout: 2000,
      env: gitEnv,
    });
    dirtyCount = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    // Ignore local git inspection errors in status view
  }

  try {
    const [countsRes, upstreamRes] = await Promise.all([
      execFileAsync(
        gitBin,
        ["-C", hubRepoPath, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        { timeout: 2000, env: gitEnv },
      ),
      execFileAsync(gitBin, ["-C", hubRepoPath, "rev-parse", "--verify", "@{upstream}"], {
        timeout: 2000,
        env: gitEnv,
      }),
    ]);
    const parts = countsRes.stdout.trim().split(/\s+/);
    aheadCount = Number(parts[0] ?? 0) || 0;
    behindCount = Number(parts[1] ?? 0) || 0;
    upstreamHead = upstreamRes.stdout.trim();
  } catch {
    // Upstream branch might not be configured
  }

  if (
    safeRealpath(hubRepoPath) !== safeRealpath(packageRepoRoot) &&
    fs.existsSync(path.join(packageRepoRoot, ".git"))
  ) {
    try {
      const [hubHeadRes, cacheHeadRes] = await Promise.all([
        execFileAsync(gitBin, ["-C", hubRepoPath, "rev-parse", "HEAD"], { timeout: 2000, env: gitEnv }),
        execFileAsync(gitBin, ["-C", packageRepoRoot, "rev-parse", "HEAD"], { timeout: 2000, env: gitEnv }),
      ]);
      const hubHead = hubHeadRes.stdout.trim();
      const cacheHead = cacheHeadRes.stdout.trim();
      cacheMismatch = Boolean(hubHead && cacheHead && hubHead !== cacheHead);
      cacheMatchesUpstream = Boolean(upstreamHead && cacheHead && upstreamHead === cacheHead);
    } catch {
      // Ignore cache comparison failure
    }
  }

  return { dirtyCount, aheadCount, behindCount, cacheMismatch, cacheMatchesUpstream };
}

export function formatHubStatusText(
  diff: StewardDiff,
  _agentDir?: string,
  gitSummary?: HubGitSummary,
): { text: string; level: "info" | "warning" } {
  const roleText =
    diff.mode === "writable-clone" && diff.hubRepoPath
      ? `可写 · ${shortenHome(diff.hubRepoPath)}`
      : "只读同步";
  const machineLabel = diff.machineId ? `${diff.machineId}（${roleText}）` : `未命名节点（${roleText}）`;

  const actions: string[] = [];
  if (gitSummary) {
    if (gitSummary.dirtyCount > 0) {
      actions.push(`工作仓有 ${gitSummary.dirtyCount} 处改动待提交`);
    }
    if (gitSummary.aheadCount > 0) {
      actions.push(`有 ${gitSummary.aheadCount} 个提交待 push`);
    }
    if (gitSummary.behindCount > 0) {
      actions.push(`工作仓落后远端 ${gitSummary.behindCount} 个提交（请手动 git pull --ff-only）`);
    }
    if (gitSummary.cacheMismatch) {
      if (gitSummary.aheadCount > 0) {
        actions.push("Pi 包缓存待更新（先 push 再执行 /reload）");
      } else if (gitSummary.behindCount > 0 && gitSummary.cacheMatchesUpstream) {
        // Cache is already aligned with upstream while hubRepoPath lags; git pull --ff-only above covers it.
      } else {
        actions.push("Pi 包缓存与远端待对齐（执行 /reload 同步）");
      }
    }
  }

  const pendingFiles = [
    ...(diff.settingsChanged ? ["settings.json"] : []),
    ...diff.fileChanges.filter((f) => f.changed).map((f) => f.targetName),
  ];
  if (pendingFiles.length > 0) {
    actions.push(`本机待写入 ${pendingFiles.join(", ")}（执行 /reload 生效）`);
  }

  const customFiles = diff.fileChanges
    .filter((f) => f.customized && f.policy === "seed-if-missing")
    .map((f) => f.targetName);

  const statusBody = actions.length === 0 ? "已对齐" : actions.join("；");
  const statusLine = customFiles.length > 0 ? `${statusBody}（本机自定义：${customFiles.join(", ")}）` : statusBody;

  const shortIncubating =
    diff.incubatingPackages.length > 0
      ? diff.incubatingPackages.map((pkg) => formatShortPackageName(pkg)).join(", ")
      : "无";

  const lines = [
    `机器：${machineLabel}`,
    `状态：${statusLine}`,
    `本机试验：${shortIncubating}`,
  ];
  return {
    text: lines.join("\n"),
    level: actions.length === 0 ? "info" : "warning",
  };
}

function safeRealpath(p: string): string {
  try {
    return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
  } catch {
    return path.resolve(p);
  }
}

export function isInsidePackageCache(candidatePath: string, agentDir: string): boolean {
  const gitCacheRoot = safeRealpath(path.join(agentDir, "git"));
  const resolvedCandidate = safeRealpath(candidatePath);
  const rel = path.relative(gitCacheRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const HOSTED_GIT_DOMAINS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  gist: "gist.github.com",
};

function splitGitRef(url: string): { repo: string; ref?: string } {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const host = scpLikeMatch[1] ?? "";
    const pathWithMaybeRef = scpLikeMatch[2] ?? "";
    const refSeparator = pathWithMaybeRef.indexOf("@");
    if (refSeparator < 0) return { repo: url };
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref) return { repo: url };
    return { repo: `git@${host}:${repoPath}`, ref };
  }
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
      const refSeparator = pathWithMaybeRef.indexOf("@");
      if (refSeparator >= 0) {
        const repoPath = pathWithMaybeRef.slice(0, refSeparator);
        const ref = pathWithMaybeRef.slice(refSeparator + 1);
        if (repoPath && ref) {
          parsed.pathname = `/${repoPath}`;
          return { repo: parsed.toString().replace(/\/$/, ""), ref };
        }
      }
      return { repo: url };
    } catch {
      return { repo: url };
    }
  }
  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

export function normalizePackageIdentity(entry: PackageSource, agentDir: string): string {
  const raw = (typeof entry === "string" ? entry : entry.source).trim();
  if (raw.startsWith("npm:")) {
    const spec = raw.slice(4).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    return `npm:${match?.[1] ?? spec}`;
  }

  const hasGitPrefix = raw.startsWith("git:");
  const urlCandidate = hasGitPrefix ? raw.slice(4).trim() : raw;
  const isProtocolGit = /^(https?|ssh|git):\/\//i.test(urlCandidate);
  const isScpGit = /^git@[^/:]+:.+/.test(urlCandidate);

  if (hasGitPrefix || isProtocolGit || isScpGit) {
    const withoutHash = urlCandidate.split("#")[0] ?? urlCandidate;
    const { repo } = splitGitRef(withoutHash);
    let host = "";
    let repoPath = "";

    const hostedPrefixMatch = repo.match(/^(github|gitlab|bitbucket|gist):(?:\/*)?(.+)$/i);
    const scpMatch = repo.match(/^git@([^/:]+):(.+)$/);
    if (hostedPrefixMatch) {
      const provider = (hostedPrefixMatch[1] ?? "").toLowerCase();
      host = HOSTED_GIT_DOMAINS[provider] ?? provider;
      repoPath = hostedPrefixMatch[2] ?? "";
    } else if (scpMatch) {
      host = scpMatch[1] ?? "";
      repoPath = scpMatch[2] ?? "";
    } else if (/^(https?|ssh|git):\/\//i.test(repo)) {
      try {
        const parsed = new URL(repo);
        host = parsed.hostname;
        repoPath = parsed.pathname.replace(/^\/+/, "");
      } catch {
        host = "";
      }
    } else {
      const cleaned = repo.replace(/^git@/, "");
      const slashIndex = cleaned.indexOf("/");
      if (slashIndex > 0) {
        const firstPart = cleaned.slice(0, slashIndex);
        const restPath = cleaned.slice(slashIndex + 1);
        if (!firstPart.includes(".") && firstPart !== "localhost" && restPath && !restPath.includes("/")) {
          host = "github.com";
          repoPath = `${firstPart}/${restPath}`;
        } else {
          host = firstPart;
          repoPath = restPath;
        }
      }
    }

    const normalizedPath = repoPath.replace(/\/+$/g, "").replace(/\.git$/i, "").replace(/^\/+/g, "");
    if (host && normalizedPath) {
      return `git:${host.toLowerCase()}/${normalizedPath}`;
    }
  }

  const expanded = expandHome(raw);
  const resolved = safeRealpath(path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(agentDir, expanded));
  return `local:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function readMachineMarker(agentDir: string): MachineMarker {
  const markerPath = path.join(agentDir, "machine.json");
  if (!fs.existsSync(markerPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as MachineMarker) : {};
  } catch {
    return {};
  }
}

export function readSyncState(agentDir: string, marker?: MachineMarker): StewardSyncState {
  const statePath = path.join(agentDir, SYNC_STATE_FILENAME);
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as StewardSyncState;
      }
    } catch {
      // Fallback to marker below
    }
  }
  return {
    lastSyncedCanonPackages: marker?.lastSyncedCanonPackages,
    lastSyncedCanonModels: marker?.lastSyncedCanonModels,
  };
}

export function resolveActiveRepoRoot(
  packageRepoRoot: string,
  marker: MachineMarker,
  agentDir: string = resolveDefaultAgentDir(),
): {
  mode: "writable-clone" | "read-only-sync";
  activeRepoRoot: string;
  hubRepoPath: string | undefined;
} {
  if (marker.hubRepoPath && typeof marker.hubRepoPath === "string") {
    const candidate = path.resolve(expandHome(marker.hubRepoPath.trim()));
    if (
      !isInsidePackageCache(candidate, agentDir) &&
      fs.existsSync(path.join(candidate, ".git")) &&
      fs.existsSync(path.join(candidate, "canon"))
    ) {
      return {
        mode: "writable-clone",
        activeRepoRoot: candidate,
        hubRepoPath: candidate,
      };
    }
  }
  return {
    mode: "read-only-sync",
    activeRepoRoot: packageRepoRoot,
    hubRepoPath: undefined,
  };
}

const SPECIAL_SETTINGS_KEYS = new Set(["defaultProvider", "defaultModel", "enabledModels", "packages"]);

function discoverCanonRelativeFiles(canonDir: string, prefix = ""): string[] {
  if (!fs.existsSync(canonDir)) return [];
  const entries = fs.readdirSync(canonDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (rel === "settings.canon.json") continue;
    const full = path.join(canonDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...discoverCanonRelativeFiles(full, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function evaluateManagedFile(spec: {
  targetName: string;
  sourcePath: string;
  targetPath: string;
  policy: FileSyncPolicy;
  backupOnInitialTakeover?: boolean;
}): ManagedFileDiff {
  const sourceContent = fs.readFileSync(spec.sourcePath, "utf8");
  const targetExists = fs.existsSync(spec.targetPath);
  const localContent = targetExists ? fs.readFileSync(spec.targetPath, "utf8") : "";

  if (spec.policy === "overwrite") {
    const changed = sourceContent !== localContent;
    return {
      ...spec,
      changed,
      customized: false,
      ...(changed ? { nextContent: sourceContent } : {}),
    };
  }

  if (spec.policy === "seed-if-empty") {
    const changed = !targetExists || !localContent.trim();
    return {
      ...spec,
      changed,
      customized: !changed && localContent.trim() !== sourceContent.trim(),
      ...(changed ? { nextContent: sourceContent } : {}),
    };
  }

  // policy === "seed-if-missing"
  const changed = !targetExists;
  return {
    ...spec,
    changed,
    customized: targetExists && localContent.trim() !== sourceContent.trim(),
    ...(changed ? { nextContent: sourceContent } : {}),
  };
}

export function computeStewardDiff(packageRepoRoot: string, agentDir: string): StewardDiff {
  const marker = readMachineMarker(agentDir);
  const syncState = readSyncState(agentDir, marker);
  const machineId = getSafeMachineId(marker.machineId);
  const { mode, activeRepoRoot, hubRepoPath } = resolveActiveRepoRoot(packageRepoRoot, marker, agentDir);

  const canonDir = path.join(activeRepoRoot, "canon");
  const canonSettingsPath = path.join(canonDir, "settings.canon.json");
  const localSettingsPath = path.join(agentDir, "settings.json");
  const statePath = path.join(agentDir, SYNC_STATE_FILENAME);

  let settingsChanged = false;
  let syncStateChanged = !fs.existsSync(statePath);

  const localSettings: CanonSettings = fs.existsSync(localSettingsPath)
    ? (JSON.parse(fs.readFileSync(localSettingsPath, "utf8")) as CanonSettings)
    : {};
  const mergedSettings: CanonSettings = structuredClone(localSettings);
  const nextSyncState: StewardSyncState = structuredClone(syncState);

  let incubatingPackages: string[] = [];

  if (fs.existsSync(canonSettingsPath)) {
    const canonSettings = JSON.parse(fs.readFileSync(canonSettingsPath, "utf8")) as CanonSettings;

    const targetProvider = marker.defaultProvider ?? canonSettings.defaultProvider;
    const targetModel = marker.defaultModel ?? canonSettings.defaultModel;
    if (targetProvider !== undefined && mergedSettings.defaultProvider !== targetProvider) {
      mergedSettings.defaultProvider = targetProvider;
      settingsChanged = true;
    }
    if (targetModel !== undefined && mergedSettings.defaultModel !== targetModel) {
      mergedSettings.defaultModel = targetModel;
      settingsChanged = true;
    }

    const currentGenericKeys = Object.keys(canonSettings)
      .filter((key) => !SPECIAL_SETTINGS_KEYS.has(key) && canonSettings[key] !== undefined)
      .sort();
    const prevGenericKeys = syncState.lastSyncedCanonSettingKeys ?? [];
    for (const prevKey of prevGenericKeys) {
      if (!SPECIAL_SETTINGS_KEYS.has(prevKey) && canonSettings[prevKey] === undefined && prevKey in mergedSettings) {
        delete mergedSettings[prevKey];
        settingsChanged = true;
      }
    }
    for (const key of currentGenericKeys) {
      if (JSON.stringify(mergedSettings[key]) !== JSON.stringify(canonSettings[key])) {
        mergedSettings[key] = structuredClone(canonSettings[key]);
        settingsChanged = true;
      }
    }
    if (JSON.stringify(prevGenericKeys) !== JSON.stringify(currentGenericKeys)) {
      nextSyncState.lastSyncedCanonSettingKeys = currentGenericKeys;
      syncStateChanged = true;
    }

    if (Array.isArray(canonSettings.enabledModels)) {
      const prevCanonModels = new Set(syncState.lastSyncedCanonModels ?? []);
      const currentCanonModels = new Set(canonSettings.enabledModels);
      const removedFromCanon = new Set([...prevCanonModels].filter((m) => !currentCanonModels.has(m)));
      const localModels = Array.isArray(mergedSettings.enabledModels) ? mergedSettings.enabledModels : [];
      const keptLocalModels = localModels.filter((m) => !removedFromCanon.has(m));
      const combinedModels = Array.from(new Set([...canonSettings.enabledModels, ...keptLocalModels]));

      if (JSON.stringify(combinedModels) !== JSON.stringify(localModels)) {
        mergedSettings.enabledModels = combinedModels;
        settingsChanged = true;
      }
      if (JSON.stringify(syncState.lastSyncedCanonModels) !== JSON.stringify(canonSettings.enabledModels)) {
        nextSyncState.lastSyncedCanonModels = [...canonSettings.enabledModels];
        syncStateChanged = true;
      }
    }

    if (Array.isArray(canonSettings.packages)) {
      const canonPkgIdentities = canonSettings.packages.map((p) => normalizePackageIdentity(p, agentDir));
      const currentCanonIdSet = new Set(canonPkgIdentities);
      const prevCanonIdSet = new Set(syncState.lastSyncedCanonPackages ?? []);
      const removedPkgIds = new Set([...prevCanonIdSet].filter((id) => !currentCanonIdSet.has(id)));

      const rawLocalPkgs = Array.isArray(mergedSettings.packages) ? mergedSettings.packages : [];
      const dedupedPkgs: PackageSource[] = [];
      const seenIds = new Set<string>();

      for (const pkg of canonSettings.packages) {
        const id = normalizePackageIdentity(pkg, agentDir);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          dedupedPkgs.push(pkg);
        }
      }

      for (const pkg of rawLocalPkgs) {
        const id = normalizePackageIdentity(pkg, agentDir);
        if (seenIds.has(id) || removedPkgIds.has(id)) {
          continue;
        }
        seenIds.add(id);
        dedupedPkgs.push(pkg);
      }

      if (JSON.stringify(dedupedPkgs) !== JSON.stringify(rawLocalPkgs)) {
        mergedSettings.packages = dedupedPkgs;
        settingsChanged = true;
      }

      if (JSON.stringify(syncState.lastSyncedCanonPackages) !== JSON.stringify(canonPkgIdentities)) {
        nextSyncState.lastSyncedCanonPackages = canonPkgIdentities;
        syncStateChanged = true;
      }

      incubatingPackages = dedupedPkgs
        .filter((p) => !currentCanonIdSet.has(normalizePackageIdentity(p, agentDir)))
        .map((p) => (typeof p === "string" ? p : p.source));
    }
  }

  const fileChanges: ManagedFileDiff[] = [];
  for (const rel of discoverCanonRelativeFiles(canonDir)) {
    const isCanonManaged = rel === "AGENTS.md" || rel === "plain-check.toml";
    fileChanges.push(
      evaluateManagedFile({
        targetName: rel,
        sourcePath: path.join(canonDir, ...rel.split("/")),
        targetPath: path.join(agentDir, ...rel.split("/")),
        policy: isCanonManaged ? "overwrite" : "seed-if-missing",
        backupOnInitialTakeover: isCanonManaged,
      }),
    );
  }

  if (machineId) {
    const poolEnvPath = path.join(activeRepoRoot, "pools", machineId, "machine-env.md");
    if (fs.existsSync(poolEnvPath)) {
      fileChanges.push(
        evaluateManagedFile({
          targetName: "APPEND_SYSTEM.md",
          sourcePath: poolEnvPath,
          targetPath: path.join(agentDir, "APPEND_SYSTEM.md"),
          policy: "seed-if-empty",
        }),
      );
    }
  }

  const hasContentChanges = settingsChanged || fileChanges.some((f) => f.changed);

  return {
    mode,
    machineId,
    activeRepoRoot,
    hubRepoPath,
    settingsChanged,
    fileChanges,
    hasContentChanges,
    syncStateChanged,
    mergedSettings,
    nextSyncState,
    incubatingPackages,
  };
}

export async function applyStewardDiff(diff: StewardDiff, agentDir: string): Promise<void> {
  if (diff.settingsChanged) {
    const serialized = JSON.stringify(diff.mergedSettings, null, 2) + "\n";
    let wroteViaLock = false;
    try {
      const mod = (await import("@earendil-works/pi-coding-agent").catch(() => null)) as {
        SettingsManager?: {
          create?: (a: string, b: string) => {
            storage?: { withLock?: (scope: "global", fn: (current?: string) => string | undefined) => void };
          };
        };
      } | null;
      const sm = mod?.SettingsManager?.create?.(agentDir, agentDir);
      if (typeof sm?.storage?.withLock === "function") {
        sm.storage.withLock("global", () => serialized);
        wroteViaLock = true;
      }
    } catch {
      wroteViaLock = false;
    }
    if (!wroteViaLock) {
      atomicWriteFileSync(path.join(agentDir, "settings.json"), serialized);
    }
  }

  const statePath = path.join(agentDir, SYNC_STATE_FILENAME);
  const isInitialTakeover = !fs.existsSync(statePath);

  for (const file of diff.fileChanges) {
    if (!file.changed || file.nextContent === undefined) continue;
    if (file.backupOnInitialTakeover && isInitialTakeover && fs.existsSync(file.targetPath)) {
      const bakPath = `${file.targetPath}.bak`;
      if (!fs.existsSync(bakPath)) {
        const existing = fs.readFileSync(file.targetPath, "utf8");
        if (existing.trim().length > 0) {
          atomicWriteFileSync(bakPath, existing);
        }
      }
    }
    atomicWriteFileSync(file.targetPath, file.nextContent);
  }

  if (diff.syncStateChanged) {
    atomicWriteFileSync(statePath, JSON.stringify(diff.nextSyncState, null, 2) + "\n");
  }
}

export function tokenizeShellClauses(command: string): string[][] {
  const clauses: string[][] = [];
  let currentClause: string[] = [];
  let currentToken = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (inToken) {
      currentClause.push(currentToken);
      currentToken = "";
      inToken = false;
    }
  };
  const pushClause = () => {
    pushToken();
    if (currentClause.length > 0) {
      clauses.push(currentClause);
      currentClause = [];
    }
  };

  const len = command.length;
  for (let i = 0; i < len; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else currentToken += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < len) {
        currentToken += command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < len && depth > 0) {
          if (command[j] === "(") depth += 1;
          else if (command[j] === ")") depth -= 1;
          j += 1;
        }
        const inner = command.slice(i + 2, Math.max(i + 2, j - 1));
        for (const sub of tokenizeShellClauses(inner)) {
          if (sub.length > 0) clauses.push(sub);
        }
        i = j - 1;
        continue;
      }
      currentToken += ch;
      continue;
    }

    if (ch === "#" && !inToken) {
      while (i < len && command[i] !== "\n") i += 1;
      pushClause();
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < len) {
      currentToken += command[i + 1]!;
      inToken = true;
      i += 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      pushToken();
      let depth = 1;
      let j = i + 2;
      while (j < len && depth > 0) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
        j += 1;
      }
      const inner = command.slice(i + 2, Math.max(i + 2, j - 1));
      for (const sub of tokenizeShellClauses(inner)) {
        if (sub.length > 0) clauses.push(sub);
      }
      i = j - 1;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      pushClause();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushToken();
      continue;
    }
    currentToken += ch;
    inToken = true;
  }
  pushClause();
  return clauses;
}

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const GIT_SUBCMD_VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "--trailer",
  "-u",
  "--cleanup",
  "--author",
  "--date",
  "--reuse-message",
  "-C",
  "-c",
]);
const GIT_HOOK_SUBCOMMANDS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);

function inspectGitHookBypass(tokens: string[]): string | undefined {
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === "command" || t === "env" || t === "sudo") {
      idx += 1;
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return undefined;
  const exe = path.posix.basename(tokens[idx]!.replace(/\\/g, "/")).toLowerCase();
  if (exe !== "git" && exe !== "git.exe") return undefined;
  idx += 1;

  let subcommand: string | undefined;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (GIT_GLOBAL_VALUE_FLAGS.has(tok)) {
      const val = tokens[idx + 1] ?? "";
      if (tok === "-c" && /^core\.hooksPath=/i.test(val)) {
        return "Blocked by pi-steward: overriding core.hooksPath is prohibited by safety rules.";
      }
      idx += 2;
      continue;
    }
    if (/^-c\s*core\.hooksPath=/i.test(tok) || /^--config-env=core\.hooksPath/i.test(tok)) {
      return "Blocked by pi-steward: overriding core.hooksPath is prohibited by safety rules.";
    }
    if (tok.startsWith("-")) {
      idx += 1;
      continue;
    }
    subcommand = tok;
    idx += 1;
    break;
  }

  if (!subcommand || !GIT_HOOK_SUBCOMMANDS.has(subcommand)) return undefined;

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === "--") break;
    if (GIT_SUBCMD_VALUE_FLAGS.has(tok)) {
      idx += 2;
      continue;
    }
    if (tok === "--no-verify") {
      return `Blocked by pi-steward: 'git ${subcommand} --no-verify' is prohibited. Fix the underlying Git hook failure instead.`;
    }
    if (subcommand === "commit" && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(tok) && !tok.startsWith("--")) {
      return "Blocked by pi-steward: 'git commit -n' (--no-verify) is prohibited. Fix the underlying Git hook failure instead.";
    }
    idx += 1;
  }

  return undefined;
}

export function evaluateToolCallGuard(event: {
  toolName: string;
  input?: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
  if (event.toolName !== "bash" && event.toolName !== "powershell") {
    return undefined;
  }
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  if (!command.trim()) return undefined;
  for (const clause of tokenizeShellClauses(command)) {
    const reason = inspectGitHookBypass(clause);
    if (reason) return { block: true, reason };
  }
  return undefined;
}

async function resolveUpstreamRef(gitBin: string, repoPath: string, gitEnv: NodeJS.ProcessEnv): Promise<string> {
  for (const candidate of ["@{upstream}", "origin/HEAD", "origin/master", "origin/main"]) {
    try {
      const { stdout } = await execFileAsync(gitBin, ["-C", repoPath, "rev-parse", "--verify", candidate], {
        timeout: 2000,
        env: gitEnv,
      });
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      // Try next candidate
    }
  }
  throw new Error("unable to resolve remote upstream ref");
}

let criticalCacheChain: Promise<void> = Promise.resolve();

export function runInCacheCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  const next = criticalCacheChain.then(fn, fn);
  criticalCacheChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function syncCacheRepoToUpstream(
  cacheRepoPath: string,
  agentDir: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; changed?: boolean; shortSha?: string; error?: string }> {
  if (isOfflineModeEnabled()) {
    return { ok: true, changed: false };
  }
  if (!isInsidePackageCache(cacheRepoPath, agentDir) || !fs.existsSync(path.join(cacheRepoPath, ".git"))) {
    return { ok: true, changed: false };
  }
  const gitBin = getGitExecutable();
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  try {
    await execFileAsync(gitBin, ["-C", cacheRepoPath, "fetch", "--quiet", "--prune", "origin"], {
      timeout: 8000,
      signal,
      env: gitEnv,
    });
  } catch (err) {
    if (signal?.aborted) {
      return { ok: true, changed: false };
    }
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, changed: false, error: msg };
  }
  if (signal?.aborted) {
    return { ok: true, changed: false };
  }

  return runInCacheCriticalSection(async () => {
    if (signal?.aborted) {
      return { ok: true, changed: false };
    }
    try {
      const prevRes = await execFileAsync(gitBin, ["-C", cacheRepoPath, "rev-parse", "HEAD"], {
        timeout: 2000,
        env: gitEnv,
      });
      const prevHead = prevRes.stdout.trim();
      const targetSha = await resolveUpstreamRef(gitBin, cacheRepoPath, gitEnv);
      await execFileAsync(gitBin, ["-C", cacheRepoPath, "reset", "--hard", "--quiet", targetSha], {
        timeout: 5000,
        env: gitEnv,
      });
      return {
        ok: true,
        changed: Boolean(prevHead && prevHead !== targetSha),
        shortSha: targetSha.slice(0, 7),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return { ok: false, changed: false, error: msg };
    }
  });
}

async function fetchHubRefsIfOnline(hubRepoPath: string, signal?: AbortSignal): Promise<void> {
  if (isOfflineModeEnabled() || !fs.existsSync(path.join(hubRepoPath, ".git"))) {
    return;
  }
  const gitBin = getGitExecutable();
  try {
    await execFileAsync(gitBin, ["-C", hubRepoPath, "fetch", "--quiet", "origin"], {
      timeout: 8000,
      signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
  } catch {
    // Non-mutating ref refresh only; never warn on offline/transient network state
  }
}

type StewardUIContext = {
  hasUI?: boolean;
  ui: {
    notify: (msg: string, level: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
};

function notifyCtx(ctx: StewardUIContext, msg: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(msg, level);
  } else if (level === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

function setStewardStatus(ctx: StewardUIContext, text: string | undefined): void {
  if (ctx.hasUI && typeof ctx.ui.setStatus === "function") {
    ctx.ui.setStatus("pi-steward", text);
  }
}

function findAddedPackageNames(agentDir: string, nextPackages: PackageSource[] | undefined): string[] {
  if (!Array.isArray(nextPackages) || nextPackages.length === 0) return [];
  const localSettingsPath = path.join(agentDir, "settings.json");
  let prevPackages: PackageSource[] = [];
  if (fs.existsSync(localSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localSettingsPath, "utf8")) as CanonSettings;
      if (Array.isArray(parsed.packages)) {
        prevPackages = parsed.packages;
      }
    } catch {
      // Ignore malformed local settings here; computeStewardDiff surfaces parse errors
    }
  }
  const prevIds = new Set(prevPackages.map((p) => normalizePackageIdentity(p, agentDir)));
  return nextPackages
    .filter((p) => !prevIds.has(normalizePackageIdentity(p, agentDir)))
    .map((p) => formatShortPackageName(p));
}

export default function (pi: ExtensionAPI) {
  const agentDir = resolveDefaultAgentDir();
  const packageRepoRoot = path.resolve(MODULE_DIR, "..");
  let activeSyncAbort: AbortController | undefined;
  let startupSyncTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelBackgroundSync = () => {
    if (startupSyncTimer) {
      clearTimeout(startupSyncTimer);
      startupSyncTimer = undefined;
    }
    if (activeSyncAbort) {
      activeSyncAbort.abort();
      activeSyncAbort = undefined;
    }
  };

  pi.on("tool_call", async (event) => {
    return evaluateToolCallGuard(event as unknown as { toolName: string; input?: Record<string, unknown> });
  });

  const reconcileLocalDiff = (ctx: StewardUIContext): Promise<boolean> =>
    runInCacheCriticalSection(async () => {
      try {
        const diff = computeStewardDiff(packageRepoRoot, agentDir);
        if (diff.hasContentChanges || diff.syncStateChanged) {
          const addedPkgs = diff.settingsChanged ? findAddedPackageNames(agentDir, diff.mergedSettings.packages) : [];
          await applyStewardDiff(diff, agentDir);
          if (diff.hasContentChanges) {
            const idLabel = diff.machineId ?? "read-only";
            const pkgHint =
              addedPkgs.length > 0
                ? `（新增插件 ${addedPkgs.join(", ")} 将在下次启动或 /reload 时下载安装）`
                : "";
            notifyCtx(
              ctx,
              `pi-steward 已同步全局配置（${idLabel}）${pkgHint}，执行 /reload 或重启 Pi 生效。`,
              "info",
            );
            return true;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyCtx(ctx, `pi-steward 同步告警：${msg}`, "warning");
      }
      return false;
    });

  const pullRemoteAndReconcile = async (
    ctx: StewardUIContext,
    hubRepoPath: string | undefined,
    statusText: string,
    signal: AbortSignal,
  ) => {
    setStewardStatus(ctx, statusText);
    try {
      const syncCache = !hubRepoPath || safeRealpath(hubRepoPath) !== safeRealpath(packageRepoRoot);
      const [, cacheRes] = await Promise.all([
        hubRepoPath ? fetchHubRefsIfOnline(hubRepoPath, signal) : Promise.resolve(),
        syncCache
          ? syncCacheRepoToUpstream(packageRepoRoot, agentDir, signal)
          : Promise.resolve({ ok: true, changed: false, shortSha: undefined, error: undefined }),
      ]);
      if (signal.aborted) return;
      if (!cacheRes.ok && cacheRes.error) {
        notifyCtx(ctx, `pi-steward 包缓存同步失败：${cacheRes.error}`, "warning");
      }
      const notified = await reconcileLocalDiff(ctx);
      if (cacheRes.changed && !notified) {
        notifyCtx(
          ctx,
          `pi-steward 已同步包缓存至 ${cacheRes.shortSha ?? "最新"}，若包含扩展或技能改动请再执行一次 /reload 加载新代码。`,
          "info",
        );
      }
    } finally {
      setStewardStatus(ctx, undefined);
    }
  };

  pi.on("session_shutdown", () => {
    cancelBackgroundSync();
  });

  pi.on("session_start", async (event, ctx) => {
    cancelBackgroundSync();
    await reconcileLocalDiff(ctx);

    if (!ctx.hasUI || isOfflineModeEnabled()) {
      return;
    }

    const marker = readMachineMarker(agentDir);
    const { hubRepoPath } = resolveActiveRepoRoot(packageRepoRoot, marker, agentDir);

    if (event.reason === "reload") {
      const controller = new AbortController();
      activeSyncAbort = controller;
      try {
        await pullRemoteAndReconcile(ctx, hubRepoPath, "pi-steward: 正在拉取远端配置…", controller.signal);
      } finally {
        if (activeSyncAbort === controller) {
          activeSyncAbort = undefined;
        }
      }
      return;
    }

    if (!event.reason || event.reason === "startup") {
      const controller = new AbortController();
      activeSyncAbort = controller;
      startupSyncTimer = setTimeout(() => {
        startupSyncTimer = undefined;
        if (controller.signal.aborted) return;
        void pullRemoteAndReconcile(
          ctx,
          hubRepoPath,
          "pi-steward: 正在检查远端配置更新…",
          controller.signal,
        ).finally(() => {
          if (activeSyncAbort === controller) {
            activeSyncAbort = undefined;
          }
        });
      }, 0);
      startupSyncTimer.unref?.();
    }
  });

  pi.registerCommand("hub-status", {
    description: "查看当前机器角色、全局配置同步状态与本机试验包",
    handler: async (_args, ctx) => {
      try {
        const diff = computeStewardDiff(packageRepoRoot, agentDir);
        const gitSummary = await inspectHubGitSummary(diff.hubRepoPath, packageRepoRoot);
        const report = formatHubStatusText(diff, agentDir, gitSummary);
        notifyCtx(ctx, report.text, report.level);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyCtx(ctx, `hub-status 检查失败：${msg}`, "error");
      }
    },
  });

  pi.registerCommand("hub-init", {
    description: "Initialize ~/.pi/agent/machine.json and git privacy hooks for a writable clone: /hub-init <machineId> [hubRepoPath]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const machineId = getSafeMachineId(parts[0]);
      if (!machineId) {
        notifyCtx(ctx, "Usage: /hub-init <machineId> [hubRepoPath] (machineId must be alphanumeric/dash/underscore)", "warning");
        return;
      }
      const existing = readMachineMarker(agentDir);
      const rawHubPath = parts[1] ?? existing.hubRepoPath;
      let resolvedHubPath: string | undefined;

      if (rawHubPath) {
        const candidate = path.resolve(expandHome(rawHubPath));
        if (isInsidePackageCache(candidate, agentDir)) {
          notifyCtx(
            ctx,
            `Refusing hubRepoPath inside Pi package cache (${candidate}). Clone the repository to a dedicated working directory outside ${path.join(agentDir, "git")}.`,
            "error",
          );
          return;
        }
        if (!fs.existsSync(path.join(candidate, ".git")) || !fs.existsSync(path.join(candidate, "canon"))) {
          notifyCtx(ctx, `Invalid hubRepoPath (must contain .git and canon/): ${candidate}`, "error");
          return;
        }
        resolvedHubPath = candidate;
        const gitBin = getGitExecutable();
        try {
          await execFileAsync(gitBin, ["-C", candidate, "config", "core.hooksPath", ".githooks"]);
          const { stdout } = await execFileAsync(gitBin, ["-C", candidate, "rev-parse", "--git-path", "info/no-upload-personal"]);
          const denylistPath = path.resolve(candidate, stdout.trim());
          if (!fs.existsSync(denylistPath) || fs.readFileSync(denylistPath, "utf8").trim() === "") {
            const entries = Array.from(new Set([os.userInfo().username, os.hostname()].filter(Boolean)));
            fs.mkdirSync(path.dirname(denylistPath), { recursive: true });
            fs.writeFileSync(denylistPath, entries.join("\n") + "\n", "utf8");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notifyCtx(ctx, `Failed to configure git hooks in ${candidate}: ${msg}`, "error");
          return;
        }
      }

      const nextMarker: MachineMarker = {
        ...existing,
        machineId,
        ...(resolvedHubPath ? { hubRepoPath: resolvedHubPath } : {}),
      };
      delete nextMarker.lastSyncedCanonPackages;
      delete nextMarker.lastSyncedCanonModels;
      atomicWriteFileSync(path.join(agentDir, "machine.json"), JSON.stringify(nextMarker, null, 2) + "\n");
      const diff = computeStewardDiff(packageRepoRoot, agentDir);
      await applyStewardDiff(diff, agentDir);
      notifyCtx(
        ctx,
        `已初始化机器 ${machineId}${resolvedHubPath ? `（可写工作仓 ${shortenHome(resolvedHubPath)}，隐私钩子已启用）` : "（只读同步节点）"}`,
        "info",
      );
    },
  });
}

