import {
  getAgentDir as piGetAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

interface HubGitSummary {
  dirtyCount: number;
  aheadCount: number;
  behindCount: number;
  cacheBehindHub: boolean;
}

async function inspectHubGitSummary(
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
  let cacheBehindHub = false;

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
    const { stdout } = await execFileAsync(
      gitBin,
      ["-C", hubRepoPath, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { timeout: 2000, env: gitEnv },
    );
    const parts = stdout.trim().split(/\s+/);
    aheadCount = Number(parts[0] ?? 0) || 0;
    behindCount = Number(parts[1] ?? 0) || 0;
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
      cacheBehindHub = Boolean(hubHead && cacheHead && hubHead !== cacheHead);
    } catch {
      // Ignore cache comparison failure
    }
  }

  return { dirtyCount, aheadCount, behindCount, cacheBehindHub };
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
      actions.push(`工作仓落后远端 ${gitSummary.behindCount} 个提交（执行 /reload 拉取）`);
    }
    if (gitSummary.cacheBehindHub) {
      actions.push(
        gitSummary.aheadCount > 0
          ? "Pi 包缓存待更新（先 push 再执行 /reload）"
          : "Pi 包缓存落后工作仓（执行 /reload 同步）",
      );
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
  agentDir: string = piGetAgentDir(),
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
    const isAgentsMd = rel === "AGENTS.md";
    fileChanges.push(
      evaluateManagedFile({
        targetName: rel,
        sourcePath: path.join(canonDir, ...rel.split("/")),
        targetPath: path.join(agentDir, ...rel.split("/")),
        policy: isAgentsMd ? "overwrite" : "seed-if-missing",
        backupOnInitialTakeover: isAgentsMd,
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
    try {
      const sm = SettingsManager.create(agentDir, agentDir) as unknown as {
        storage?: { withLock?: (scope: "global", fn: (current?: string) => string | undefined) => void };
      };
      if (typeof sm.storage?.withLock === "function") {
        sm.storage.withLock("global", () => serialized);
      } else {
        atomicWriteFileSync(path.join(agentDir, "settings.json"), serialized);
      }
    } catch {
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

async function pullRepoIfOnline(repoPath: string): Promise<{ ok: boolean; error?: string }> {
  if (isOfflineModeEnabled()) {
    return { ok: true };
  }
  const gitBin = getGitExecutable();
  try {
    await execFileAsync(gitBin, ["-C", repoPath, "pull", "--ff-only", "--quiet"], {
      timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, error: msg };
  }
}

function notifyCtx(ctx: { hasUI?: boolean; ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }, msg: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(msg, level);
  } else if (level === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

export default function (pi: ExtensionAPI) {
  const agentDir = piGetAgentDir();
  const packageRepoRoot = path.resolve(__dirname, "..");

  pi.on("session_start", async (event, ctx) => {
    const isInitialStart = !event.reason || event.reason === "startup" || event.reason === "reload";
    const marker = readMachineMarker(agentDir);
    const { activeRepoRoot, hubRepoPath } = resolveActiveRepoRoot(packageRepoRoot, marker, agentDir);

    if (isInitialStart) {
      const pullRes = await pullRepoIfOnline(activeRepoRoot);
      if (!pullRes.ok && pullRes.error) {
        notifyCtx(ctx, `pi-steward git pull skipped (${path.basename(activeRepoRoot)}): ${pullRes.error}`, "warning");
      }
      if (hubRepoPath && safeRealpath(hubRepoPath) !== safeRealpath(packageRepoRoot)) {
        const cachePullRes = await pullRepoIfOnline(packageRepoRoot);
        if (!cachePullRes.ok && cachePullRes.error) {
          notifyCtx(ctx, `pi-steward package cache git pull skipped: ${cachePullRes.error}`, "warning");
        }
      }
    }

    try {
      const diff = computeStewardDiff(packageRepoRoot, agentDir);
      if (diff.hasContentChanges || diff.syncStateChanged) {
        await applyStewardDiff(diff, agentDir);
        if (diff.hasContentChanges) {
          const idLabel = diff.machineId ?? "read-only";
          notifyCtx(
            ctx,
            `pi-steward 已同步全局配置（${idLabel}），执行 /reload 或重启 Pi 生效。`,
            "info",
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyCtx(ctx, `pi-steward 同步告警：${msg}`, "warning");
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

