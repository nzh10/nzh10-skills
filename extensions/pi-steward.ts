import type { ExtensionAPI, PackageSource } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

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
  skillful?: { enabled?: boolean };
}

export interface StewardSyncState {
  lastSyncedCanonPackages?: string[];
  lastSyncedCanonModels?: string[];
  lastSyncedCanonSettingKeys?: string[];
  lastSyncedLocalHubPackage?: string;
  seenVisibleCanon?: string[];
  loginGuideShown?: boolean;
  skillfulPackageId?: string;
  pendingSettings?: { changes: PendingSettingChange[]; nextState: StewardSyncState };
}

type SettingValue = { present: false } | { present: true; value: unknown };
type PendingSettingChange = { key: string; before: SettingValue; after: SettingValue };

export type ProviderVisibility = "configured" | "unconfigured" | "unknown";

export interface ModelRegistryLike {
  getProvider?: (provider: string) => unknown;
  getProviderAuthStatus?: (provider: string) => { configured?: boolean } | undefined;
}

export interface ComputeStewardDiffOptions {
  /** Whether enabledModels sync & seenVisibleCanon progression should run (TUI only in runtime). */
  syncModels?: boolean;
  /** Provider visibility probe (defaults to probing modelRegistry when provided). */
  getProviderVisibility?: (provider: string) => ProviderVisibility;
  /** Optional Pi ModelRegistry instance used to construct the visibility probe. */
  modelRegistry?: ModelRegistryLike;
}

export interface SettingsManagedPatch {
  setKeys: Record<string, unknown>;
  deleteKeys: string[];
  expectedLocalEnabledModels?: string[];
  touchesEnabledModels: boolean;
}

export interface SettingsStorageLike {
  withLock: (scope: "global", fn: (current: string | undefined) => string | undefined) => void;
}

export interface ApplyStewardDiffOptions {
  settingsStorage?: SettingsStorageLike;
  recordLoginGuide?: boolean;
}

export interface ApplyStewardDiffResult {
  applied: boolean;
  settingsWritten: boolean;
  conflict?: boolean;
  lockError?: string;
  actualDiff?: StewardDiff;
  loginGuideProviders?: string[];
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
  packageRepoRoot: string;
  computeOptions?: ComputeStewardDiffOptions;
  hasPendingSettings: boolean;
  mode: "writable-clone" | "read-only-sync";
  machineId: string | undefined;
  activeRepoRoot: string;
  hubRepoPath: string | undefined;
  settingsChanged: boolean;
  enabledModelsChanged: boolean;
  missingAuthProviders: string[];
  fileChanges: ManagedFileDiff[];
  hasContentChanges: boolean;
  syncStateChanged: boolean;
  mergedSettings: CanonSettings;
  settingsPatch: SettingsManagedPatch;
  nextSyncState: StewardSyncState;
  incubatingPackages: string[];
}

const SYNC_STATE_FILENAME = ".pi-steward-state.json";
const CANON_SELF_PACKAGE_ID = "git:github.com/nzh10/nzh10-skills";

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
  runtimeSourceMismatch?: boolean;
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
  const runtimeSourceMismatch = safeRealpath(hubRepoPath) !== safeRealpath(packageRepoRoot);

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

  if (runtimeSourceMismatch && fs.existsSync(path.join(packageRepoRoot, ".git"))) {
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

  return { dirtyCount, aheadCount, behindCount, cacheMismatch, cacheMatchesUpstream, runtimeSourceMismatch };
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
    if (gitSummary.aheadCount > 0 && gitSummary.behindCount > 0) {
      actions.push(
        `工作仓与远端已分叉（领先 ${gitSummary.aheadCount}、落后 ${gitSummary.behindCount} 个提交，请执行 git pull --rebase）`,
      );
    } else if (gitSummary.aheadCount > 0) {
      actions.push(`有 ${gitSummary.aheadCount} 个提交待 push`);
    } else if (gitSummary.behindCount > 0) {
      actions.push(`工作仓落后远端 ${gitSummary.behindCount} 个提交（请手动 git pull --ff-only）`);
    }
    if (diff.mode === "writable-clone") {
      if (gitSummary.runtimeSourceMismatch && !diff.settingsChanged) {
        actions.push("当前会话扩展仍取自旧路径（执行 /reload 切至本地工作仓）");
      }
    } else if (gitSummary.cacheMismatch) {
      if (gitSummary.behindCount > 0 && gitSummary.cacheMatchesUpstream) {
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
  if (diff.missingAuthProviders.length > 0) {
    lines.push(
      `缺登厂商：${diff.missingAuthProviders.join(", ")}（可按需 /login，补登后执行 /reload 再 /new 或重启 Pi 生效）`,
    );
  }
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
  const target = path.basename(filePath) === "settings.json" && fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, `.${path.basename(target)}-`));
  const next = path.join(tmp, "next");
  try {
    const mode = path.basename(filePath) === SYNC_STATE_FILENAME ? 0o600
      : fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    const fd = fs.openSync(next, "wx", mode);
    try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(next, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

const SPECIAL_SETTINGS_KEYS = new Set(["defaultProvider", "defaultModel", "enabledModels", "packages", "skillful"]);
const MODEL_PROVIDER_GLOB_RE = /[*?[\]{}]/;

export function extractExactModelProvider(entry: string): string | undefined {
  const slash = entry.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = entry.slice(0, slash);
  if (MODEL_PROVIDER_GLOB_RE.test(provider)) return undefined;
  return provider;
}

export function createProviderVisibilityProbe(
  modelRegistry?: ModelRegistryLike,
): ((provider: string) => ProviderVisibility) | undefined {
  if (!modelRegistry || typeof modelRegistry.getProviderAuthStatus !== "function") {
    return undefined;
  }
  return (provider: string): ProviderVisibility => {
    try {
      if (typeof modelRegistry.getProvider === "function") {
        const reg = modelRegistry.getProvider(provider);
        if (!reg) return "unknown";
      }
      const status = modelRegistry.getProviderAuthStatus!(provider);
      if (!status || typeof status.configured !== "boolean") {
        return "unknown";
      }
      return status.configured ? "configured" : "unconfigured";
    } catch {
      return "unknown";
    }
  };
}

function dedupeStrings(items: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export type PromoteModelsOptions =
  | {
      mode: "explicit";
      add?: readonly string[];
      remove?: readonly string[];
      getProviderVisibility?: (provider: string) => ProviderVisibility;
      modelRegistry?: ModelRegistryLike;
    }
  | {
      mode: "align-providers";
      localModels: readonly string[] | undefined;
      targetProviders: readonly string[];
      getProviderVisibility?: (provider: string) => ProviderVisibility;
      modelRegistry?: ModelRegistryLike;
    };

export function mergeCanonModelsForPromote(
  canonModels: readonly string[],
  options: PromoteModelsOptions,
): string[] {
  const probe = options.getProviderVisibility ?? createProviderVisibilityProbe(options.modelRegistry);
  if (!probe) {
    throw new Error("mergeCanonModelsForPromote requires getProviderVisibility or modelRegistry");
  }

  const assertConfigured = (provider: string, contextLabel: string): void => {
    const visibility = probe(provider);
    if (visibility !== "configured") {
      throw new Error(
        `Refusing to modify Canon entries for ${visibility} provider "${provider}" (${contextLabel})`,
      );
    }
  };

  const baseCanon = dedupeStrings(canonModels);

  if (options.mode === "explicit") {
    const toRemove = dedupeStrings(options.remove ?? []);
    const toAdd = dedupeStrings(options.add ?? []);

    for (const model of toRemove) {
      const provider = extractExactModelProvider(model);
      if (provider) assertConfigured(provider, `remove ${model}`);
    }
    for (const model of toAdd) {
      const provider = extractExactModelProvider(model);
      if (provider) assertConfigured(provider, `add ${model}`);
    }

    const removeSet = new Set(toRemove);
    const result = baseCanon.filter((m) => !removeSet.has(m));
    const existingSet = new Set(result);
    for (const model of toAdd) {
      if (!existingSet.has(model)) {
        existingSet.add(model);
        result.push(model);
      }
    }
    return result;
  }

  // mode === "align-providers"
  if (!Array.isArray(options.localModels) || options.localModels.length === 0) {
    throw new Error(
      "align-providers promote requires a non-empty local enabledModels array (refusing [] or undefined)",
    );
  }
  const targetProviders = dedupeStrings(options.targetProviders);
  if (targetProviders.length === 0) {
    throw new Error("align-providers promote requires at least one targetProvider");
  }

  for (const provider of targetProviders) {
    if (provider.includes("/") || MODEL_PROVIDER_GLOB_RE.test(provider)) {
      throw new Error(`Invalid targetProvider "${provider}"`);
    }
    assertConfigured(provider, `align provider ${provider}`);
  }

  const localDeduped = dedupeStrings(options.localModels);
  const targetSet = new Set(targetProviders);
  const desiredByProvider = new Map<string, string[]>();
  for (const provider of targetProviders) {
    desiredByProvider.set(
      provider,
      localDeduped.filter((m) => extractExactModelProvider(m) === provider),
    );
  }

  const lastSlotIndex = new Map<string, number>();
  for (let i = 0; i < baseCanon.length; i += 1) {
    const provider = extractExactModelProvider(baseCanon[i]!);
    if (provider && targetSet.has(provider)) {
      lastSlotIndex.set(provider, i);
    }
  }

  const cursorByProvider = new Map<string, number>();
  for (const provider of targetProviders) {
    cursorByProvider.set(provider, 0);
  }

  const result: string[] = [];
  for (let i = 0; i < baseCanon.length; i += 1) {
    const entry = baseCanon[i]!;
    const provider = extractExactModelProvider(entry);
    if (!provider || !targetSet.has(provider)) {
      result.push(entry);
      continue;
    }
    const desired = desiredByProvider.get(provider) ?? [];
    let cursor = cursorByProvider.get(provider) ?? 0;
    if (cursor < desired.length) {
      result.push(desired[cursor]!);
      cursor += 1;
      cursorByProvider.set(provider, cursor);
    }
    if (i === lastSlotIndex.get(provider)) {
      while (cursor < desired.length) {
        result.push(desired[cursor]!);
        cursor += 1;
      }
      cursorByProvider.set(provider, cursor);
    }
  }

  for (const provider of targetProviders) {
    if (!lastSlotIndex.has(provider)) {
      const desired = desiredByProvider.get(provider) ?? [];
      for (const model of desired) {
        result.push(model);
      }
    }
  }

  return result;
}

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

export function computeStewardDiff(
  packageRepoRoot: string,
  agentDir: string,
  options?: ComputeStewardDiffOptions,
  current?: { settings: CanonSettings; state?: StewardSyncState },
): StewardDiff {
  const markerPath = path.join(agentDir, "machine.json");
  const statePath = path.join(agentDir, SYNC_STATE_FILENAME);
  const marker = readOptionalObject(markerPath) as MachineMarker | undefined ?? {};
  if (marker.skillful !== undefined && (!isJsonObject(marker.skillful) ||
    (marker.skillful.enabled !== undefined && typeof marker.skillful.enabled !== "boolean"))) {
    throw new Error("Invalid machine.skillful.enabled");
  }
  const savedState = current ? current.state : readOptionalObject(statePath) as StewardSyncState | undefined;
  const syncState: StewardSyncState = savedState ?? {
    lastSyncedCanonPackages: marker.lastSyncedCanonPackages,
    lastSyncedCanonModels: marker.lastSyncedCanonModels,
  };
  const machineId = getSafeMachineId(marker.machineId);
  const { mode, activeRepoRoot, hubRepoPath } = resolveActiveRepoRoot(packageRepoRoot, marker, agentDir);

  const canonDir = path.join(activeRepoRoot, "canon");
  const canonSettingsPath = path.join(canonDir, "settings.canon.json");
  const localSettingsPath = path.join(agentDir, "settings.json");

  let settingsChanged = false;
  let enabledModelsChanged = false;
  let syncStateChanged = !fs.existsSync(statePath);

  const existingSettings = current?.settings ?? readOptionalObject(localSettingsPath);
  if (!existingSettings && savedState) throw new Error("settings.json is missing after takeover");
  const localSettings: CanonSettings = existingSettings ?? {};
  const localSkillful = settingsObject(localSettings.skillful, "settings.skillful");
  if (!savedState && Object.hasOwn(localSkillful, "visibilityDefaults")) {
    throw new Error("Local steward state is missing after Skillful takeover");
  }
  const mergedSettings: CanonSettings = structuredClone(localSettings);
  const nextSyncState: StewardSyncState = structuredClone(syncState);
  const settingsPatch: SettingsManagedPatch = {
    setKeys: {},
    deleteKeys: [],
    expectedLocalEnabledModels: Array.isArray(localSettings.enabledModels)
      ? [...localSettings.enabledModels]
      : undefined,
    touchesEnabledModels: false,
  };

  let incubatingPackages: string[] = [];
  const missingAuthProviders: string[] = [];

  const visibilityProbe =
    options?.getProviderVisibility ?? createProviderVisibilityProbe(options?.modelRegistry);
  const shouldSyncModels = options?.syncModels ?? Boolean(visibilityProbe);

  const canonSettings = readOptionalObject(canonSettingsPath) as CanonSettings | undefined;
  if (canonSettings) {
    const targetProvider = marker.defaultProvider ?? canonSettings.defaultProvider;
    const targetModel = marker.defaultModel ?? canonSettings.defaultModel;
    if (targetProvider !== undefined && mergedSettings.defaultProvider !== targetProvider) {
      mergedSettings.defaultProvider = targetProvider;
      settingsPatch.setKeys.defaultProvider = targetProvider;
      settingsChanged = true;
    }
    if (targetModel !== undefined && mergedSettings.defaultModel !== targetModel) {
      mergedSettings.defaultModel = targetModel;
      settingsPatch.setKeys.defaultModel = targetModel;
      settingsChanged = true;
    }

    const currentGenericKeys = Object.keys(canonSettings)
      .filter((key) => !SPECIAL_SETTINGS_KEYS.has(key) && canonSettings[key] !== undefined)
      .sort();
    const prevGenericKeys = syncState.lastSyncedCanonSettingKeys ?? [];
    for (const prevKey of prevGenericKeys) {
      if (!SPECIAL_SETTINGS_KEYS.has(prevKey) && canonSettings[prevKey] === undefined && prevKey in mergedSettings) {
        delete mergedSettings[prevKey];
        settingsPatch.deleteKeys.push(prevKey);
        settingsChanged = true;
      }
    }
    for (const key of currentGenericKeys) {
      if (JSON.stringify(mergedSettings[key]) !== JSON.stringify(canonSettings[key])) {
        mergedSettings[key] = structuredClone(canonSettings[key]);
        settingsPatch.setKeys[key] = structuredClone(canonSettings[key]);
        settingsChanged = true;
      }
    }
    if (JSON.stringify(prevGenericKeys) !== JSON.stringify(currentGenericKeys)) {
      nextSyncState.lastSyncedCanonSettingKeys = currentGenericKeys;
      syncStateChanged = true;
    }

    if (Array.isArray(canonSettings.enabledModels) && visibilityProbe) {
      const canonModels = dedupeStrings(canonSettings.enabledModels);
      const canonSet = new Set(canonModels);
      const visibleCanon: string[] = [];
      const seenMissingProviders = new Set<string>();
      const providerVisibilityCache = new Map<string, ProviderVisibility>();

      for (const model of canonModels) {
        const provider = extractExactModelProvider(model);
        if (!provider) {
          visibleCanon.push(model);
          continue;
        }
        let visibility = providerVisibilityCache.get(provider);
        if (visibility === undefined) {
          visibility = visibilityProbe(provider);
          providerVisibilityCache.set(provider, visibility);
        }
        if (visibility === "configured") {
          visibleCanon.push(model);
        } else if (visibility === "unconfigured") {
          if (!seenMissingProviders.has(provider)) {
            seenMissingProviders.add(provider);
            missingAuthProviders.push(provider);
          }
        }
      }

      if (shouldSyncModels) {
        const visibleSet = new Set(visibleCanon);
        const hasSeenVisible = Array.isArray(syncState.seenVisibleCanon);
        const hasLegacyModels = Array.isArray(syncState.lastSyncedCanonModels);
        const localModels = Array.isArray(mergedSettings.enabledModels)
          ? mergedSettings.enabledModels
          : undefined;

        if (!hasSeenVisible && !hasLegacyModels && localModels === undefined) {
          // Fresh machine first takeover: write [...V] (even [] when 0 providers configured)
          mergedSettings.enabledModels = [...visibleCanon];
          settingsPatch.setKeys.enabledModels = [...visibleCanon];
          settingsPatch.touchesEnabledModels = true;
          settingsChanged = true;
          enabledModelsChanged = true;
          nextSyncState.seenVisibleCanon = [...visibleCanon];
          delete nextSyncState.lastSyncedCanonModels;
          syncStateChanged = true;
        } else if (localModels === undefined) {
          // Already taken over and user left enabledModels unset (Ctrl+A unrestricted): keep unset, advance P
          const pBase = hasSeenVisible
            ? syncState.seenVisibleCanon!
            : syncState.lastSyncedCanonModels!.filter((m) => visibleSet.has(m));
          const pKeptSet = new Set(pBase.filter((m) => canonSet.has(m)));
          const pNext = canonModels.filter((m) => pKeptSet.has(m) || visibleSet.has(m));
          if (!hasSeenVisible || hasLegacyModels || JSON.stringify(syncState.seenVisibleCanon) !== JSON.stringify(pNext)) {
            nextSyncState.seenVisibleCanon = pNext;
            delete nextSyncState.lastSyncedCanonModels;
            syncStateChanged = true;
          }
        } else {
          // Local enabledModels is an array ([] or [...]): incremental V - P merge
          const pBase = hasSeenVisible
            ? syncState.seenVisibleCanon!
            : hasLegacyModels
              ? syncState.lastSyncedCanonModels!.filter((m) => visibleSet.has(m))
              : [];
          const removedFromCanon = new Set(
            hasSeenVisible
              ? pBase.filter((m) => !canonSet.has(m))
              : hasLegacyModels
                ? syncState.lastSyncedCanonModels!.filter((m) => !canonSet.has(m))
                : [],
          );
          const pKeptSet = new Set(pBase.filter((m) => canonSet.has(m)));
          const addedVisible = visibleCanon.filter((m) => !pKeptSet.has(m));
          const keptLocal = localModels.filter((m) => !removedFromCanon.has(m));
          const keptLocalSet = new Set(keptLocal);
          const nextModels = [...keptLocal, ...addedVisible.filter((m) => !keptLocalSet.has(m))];
          const pNext = canonModels.filter((m) => pKeptSet.has(m) || visibleSet.has(m));

          if (JSON.stringify(nextModels) !== JSON.stringify(localModels)) {
            mergedSettings.enabledModels = nextModels;
            settingsPatch.setKeys.enabledModels = [...nextModels];
            settingsPatch.touchesEnabledModels = true;
            settingsChanged = true;
            enabledModelsChanged = true;
          }
          if (!hasSeenVisible || hasLegacyModels || JSON.stringify(syncState.seenVisibleCanon) !== JSON.stringify(pNext)) {
            nextSyncState.seenVisibleCanon = pNext;
            delete nextSyncState.lastSyncedCanonModels;
            syncStateChanged = true;
          }
        }
      }
    }

    if (Array.isArray(canonSettings.packages)) {
      const canonPkgIdentities = canonSettings.packages.map((p) => normalizePackageIdentity(p, agentDir));
      const currentCanonIdSet = new Set(canonPkgIdentities);
      const prevCanonIdSet = new Set(syncState.lastSyncedCanonPackages ?? []);
      const removedPkgIds = new Set([...prevCanonIdSet].filter((id) => !currentCanonIdSet.has(id)));

      const activeLocalHubSource =
        mode === "writable-clone" && hubRepoPath ? shortenHome(hubRepoPath) : undefined;
      const activeLocalHubId =
        mode === "writable-clone" && hubRepoPath ? normalizePackageIdentity(hubRepoPath, agentDir) : undefined;
      const prevLocalHubId = syncState.lastSyncedLocalHubPackage;
      if (prevLocalHubId && prevLocalHubId !== activeLocalHubId) {
        removedPkgIds.add(prevLocalHubId);
      }

      const rawLocalPkgs = Array.isArray(mergedSettings.packages) ? mergedSettings.packages : [];
      const dedupedPkgs: PackageSource[] = [];
      const seenIds = new Set<string>();

      for (const pkg of canonSettings.packages) {
        const id = normalizePackageIdentity(pkg, agentDir);
        if (activeLocalHubSource && activeLocalHubId && id === CANON_SELF_PACKAGE_ID) {
          if (!seenIds.has(id) && !seenIds.has(activeLocalHubId)) {
            seenIds.add(id);
            seenIds.add(activeLocalHubId);
            dedupedPkgs.push(activeLocalHubSource);
          }
          continue;
        }
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
        settingsPatch.setKeys.packages = structuredClone(dedupedPkgs);
        settingsChanged = true;
      }

      if (JSON.stringify(syncState.lastSyncedCanonPackages) !== JSON.stringify(canonPkgIdentities)) {
        nextSyncState.lastSyncedCanonPackages = canonPkgIdentities;
        syncStateChanged = true;
      }

      if (prevLocalHubId !== activeLocalHubId) {
        if (activeLocalHubId) {
          nextSyncState.lastSyncedLocalHubPackage = activeLocalHubId;
        } else {
          delete nextSyncState.lastSyncedLocalHubPackage;
        }
        syncStateChanged = true;
      }

      incubatingPackages = dedupedPkgs
        .filter((p) => {
          const id = normalizePackageIdentity(p, agentDir);
          return !currentCanonIdSet.has(id) && id !== activeLocalHubId;
        })
        .map((p) => (typeof p === "string" ? p : p.source));
    }
  }

  if (canonSettings) {
    const managedPath = path.join(activeRepoRoot, "packages", "pi-skillful");
    const managedId = normalizePackageIdentity(managedPath, agentDir);
    const isSkillful = (pkg: PackageSource): boolean => {
      const id = normalizePackageIdentity(pkg, agentDir);
      return id === "npm:pi-skillful" || id === managedId || id === syncState.skillfulPackageId;
    };
    if (canonSettings.packages?.some(isSkillful)) throw new Error("Skillful is optional; remove its source from canon.packages");
    const packages = mergedSettings.packages ?? [];
    const selected = packages.find(isSkillful);
    const enabled = marker.skillful?.enabled ?? selected !== undefined;
    const nextPackages = packages.filter(pkg => !isSkillful(pkg));
    if (enabled) {
      const manifest = readOptionalObject(path.join(managedPath, "package.json"));
      if (manifest?.name !== "pi-skillful" || !fs.existsSync(path.join(managedPath, "index.ts"))) {
        throw new Error("Managed pi-skillful is missing or invalid; keeping the current source");
      }
      const source = shortenHome(managedPath);
      const entry = typeof selected === "object" ? { ...selected, source } : source;
      nextPackages.splice(selected === undefined ? nextPackages.length : packages.indexOf(selected), 0, entry);
    }
    if (!isDeepStrictEqual(packages, nextPackages)) {
      mergedSettings.packages = nextPackages;
      settingsPatch.setKeys.packages = nextPackages;
      settingsChanged = true;
    }
    if (syncState.skillfulPackageId !== (enabled ? managedId : undefined)) {
      if (enabled) nextSyncState.skillfulPackageId = managedId;
      else delete nextSyncState.skillfulPackageId;
      syncStateChanged = true;
    }
    incubatingPackages = incubatingPackages.filter(pkg => !isSkillful(pkg));

    const shared = settingsObject(canonSettings.skillful, "canon.skillful");
    const defaults = settingsObject(shared.visibility, "canon.skillful.visibility");
    for (const [id, choice] of Object.entries(defaults)) {
      if (!/^hub:skills\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/.test(id) || (choice !== "show" && choice !== "hide")) {
        throw new Error("Invalid public Skillful visibility default");
      }
    }
    if (enabled || Object.hasOwn(localSkillful, "visibilityDefaults")) {
      if (!isDeepStrictEqual(localSkillful.visibilityDefaults, defaults)) {
        const nextSkillful = { ...localSkillful, visibilityDefaults: defaults };
        mergedSettings.skillful = nextSkillful;
        settingsPatch.setKeys.skillful = nextSkillful;
        settingsChanged = true;
      }
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
    packageRepoRoot,
    computeOptions: options,
    hasPendingSettings: syncState.pendingSettings !== undefined,
    mode,
    machineId,
    activeRepoRoot,
    hubRepoPath,
    settingsChanged,
    enabledModelsChanged,
    missingAuthProviders,
    fileChanges,
    hasContentChanges,
    syncStateChanged,
    mergedSettings,
    settingsPatch,
    nextSyncState,
    incubatingPackages,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settingsObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function readOptionalObject(file: string): Record<string, unknown> | undefined {
  try { return parseObject(fs.readFileSync(file, "utf8"), path.basename(file)); }
  catch (err) { if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined; throw err; }
}

const SKILLFUL_DEFAULTS = "skillful.visibilityDefaults";

function settingValue(settings: CanonSettings, key: string): SettingValue {
  const record = key === SKILLFUL_DEFAULTS ? settingsObject(settings.skillful, "settings.skillful") : settings;
  const property = key === SKILLFUL_DEFAULTS ? "visibilityDefaults" : key;
  return Object.hasOwn(record, property) ? { present: true, value: record[property] } : { present: false };
}

function applySettingChanges(settings: CanonSettings, changes: PendingSettingChange[]): CanonSettings {
  const result: CanonSettings = { ...settings };
  for (const { key, after } of changes) {
    const record = key === SKILLFUL_DEFAULTS ? { ...settingsObject(result.skillful, "settings.skillful") } : result;
    const property = key === SKILLFUL_DEFAULTS ? "visibilityDefaults" : key;
    if (after.present) Object.defineProperty(record, property, { value: after.value, writable: true, enumerable: true, configurable: true });
    else delete record[property];
    if (key === SKILLFUL_DEFAULTS) result.skillful = record;
  }
  return result;
}

function pendingSettingChanges(before: CanonSettings, diff: StewardDiff): PendingSettingChange[] {
  const keys = [...new Set([...diff.settingsPatch.deleteKeys, ...Object.keys(diff.settingsPatch.setKeys)])];
  return keys.map(key => key === "skillful" ? SKILLFUL_DEFAULTS : key).map(key => ({
    key, before: settingValue(before, key), after: settingValue(diff.mergedSettings, key),
  })).filter(change => !isDeepStrictEqual(change.before, change.after));
}

function validSettingValue(value: unknown): value is SettingValue {
  return isJsonObject(value) && (value.present === false || (value.present === true && Object.hasOwn(value, "value")));
}

function seedSettingsIfMissing(settingsPath: string): void {
  // SDK storage locks after the callback when the settings file does not exist.
  // Create only an empty file, exclusively; merge settings in the subsequent locked read.
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try { fs.writeFileSync(settingsPath, "{}\n", { mode: 0o600, flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err; }
}

export async function applyStewardDiff(
  diff: StewardDiff,
  agentDir: string,
  options?: ApplyStewardDiffOptions,
): Promise<ApplyStewardDiffResult> {
  const statePath = path.join(agentDir, SYNC_STATE_FILENAME);
  const settingsPath = path.join(agentDir, "settings.json");
  let settingsWritten = false;
  let conflict = false;
  let actualDiff: StewardDiff | undefined;
  let loginGuideProviders: string[] | undefined;
  const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  try {
    const storage = options?.settingsStorage ?? ((await import("@earendil-works/pi-coding-agent")).SettingsManager
      .create(agentDir, agentDir) as unknown as { storage: SettingsStorageLike }).storage;
    if (typeof storage?.withLock !== "function") throw new Error("Pi global settings lock is unavailable");

    if (!fs.existsSync(settingsPath)) {
      if (fs.existsSync(statePath)) throw new Error("settings.json is missing after takeover");
      seedSettingsIfMissing(settingsPath);
    }
    storage.withLock("global", (current) => {
      if (current === undefined) throw new Error("settings.json disappeared before locking");
      let settings = parseObject(current, "settings.json") as CanonSettings;
      let state = readOptionalObject(statePath) as StewardSyncState | undefined;
      const initialTakeover = state === undefined;
      if (state?.pendingSettings !== undefined) {
        const pending = state.pendingSettings;
        if (!isJsonObject(pending) || !Array.isArray(pending.changes) || !isJsonObject(pending.nextState) ||
          pending.nextState.pendingSettings !== undefined || pending.changes.length === 0 ||
          pending.changes.some(change => !isJsonObject(change) || typeof change.key !== "string" ||
            !validSettingValue(change.before) || !validSettingValue(change.after))) {
          throw new Error("Invalid pending settings transaction; preserving current files");
        }
        const matches = (phase: "before" | "after") => pending.changes.every(change =>
          isDeepStrictEqual(settingValue(settings, change.key), change[phase]));
        if (matches("before")) {
          settings = applySettingChanges(settings, pending.changes);
          atomicWriteFileSync(settingsPath, serialize(settings));
          settingsWritten = true;
        } else if (!matches("after")) {
          conflict = true;
          return undefined;
        }
        state = pending.nextState;
        atomicWriteFileSync(statePath, serialize(state));
      } else if (diff.settingsPatch.touchesEnabledModels && !isDeepStrictEqual(
        Array.isArray(settings.enabledModels) ? settings.enabledModels : undefined,
        diff.settingsPatch.expectedLocalEnabledModels,
      )) {
        conflict = true;
        return undefined;
      }

      // Re-plan from the locked snapshot; independent updates never reuse a stale settings patch.
      actualDiff = computeStewardDiff(diff.packageRepoRoot, agentDir, diff.computeOptions, { settings, state });
      const nextState = actualDiff.nextSyncState;
      delete nextState.pendingSettings;
      if (options?.recordLoginGuide && !nextState.loginGuideShown && actualDiff.missingAuthProviders.length > 0) {
        nextState.loginGuideShown = true;
        loginGuideProviders = actualDiff.missingAuthProviders;
      }
      for (const file of actualDiff.fileChanges) {
        if (!file.changed || file.nextContent === undefined) continue;
        if (file.backupOnInitialTakeover && initialTakeover && fs.existsSync(file.targetPath)) {
          const bakPath = `${file.targetPath}.bak`;
          const existing = fs.readFileSync(file.targetPath, "utf8");
          if (!fs.existsSync(bakPath) && existing.trim().length > 0) atomicWriteFileSync(bakPath, existing);
        }
        atomicWriteFileSync(file.targetPath, file.nextContent);
      }

      const changes = pendingSettingChanges(settings, actualDiff);
      if (changes.length > 0) {
        atomicWriteFileSync(statePath, serialize({ ...state, pendingSettings: { changes, nextState } }));
        atomicWriteFileSync(settingsPath, serialize(applySettingChanges(settings, changes)));
        settingsWritten = true;
      }
      if (changes.length > 0 || actualDiff.syncStateChanged || loginGuideProviders) {
        atomicWriteFileSync(statePath, serialize(nextState));
      }
      return undefined; // We write atomically in the callback; the SDK must not write again.
    });
  } catch (err) {
    return { applied: false, settingsWritten, lockError: err instanceof Error ? err.message : String(err) };
  }
  if (conflict) return { applied: false, settingsWritten, conflict: true };
  if (!actualDiff) return { applied: false, settingsWritten, lockError: "Pi settings lock did not run the update" };
  return { applied: true, settingsWritten, actualDiff, loginGuideProviders };
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

const CACHE_FETCH_TIMEOUT_MS = 8000;
const CACHE_FETCH_RETRY_DELAY_MS = 750;

function describeGitFailure(error: unknown, timeoutMs?: number): { message: string; retryable: boolean } {
  const failure = error as (Error & { stderr?: unknown; killed?: boolean; signal?: string }) | undefined;
  const stderr = typeof failure?.stderr === "string" ? failure.stderr.trim() : "";
  const timedOut = timeoutMs !== undefined && failure?.killed === true && failure.signal === "SIGTERM";
  const detail = stderr || (failure?.message ?? String(error));
  const safeDetail = detail.replace(/(\bhttps?:\/\/)[^/\s@]+@/gi, "$1[redacted]@").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 600);
  const message = timedOut
    ? `Git fetch timed out after ${timeoutMs / 1000}s${stderr ? `: ${safeDetail}` : ""}`
    : safeDetail;
  const retryable = timedOut || /SSL_ERROR_SYSCALL|SSL_ERROR_ZERO_RETURN|unexpected eof|connection (?:reset|closed|timed out)|operation timed out|early EOF|failed to connect|could not resolve host|remote end hung up|requested URL returned error: (?:502|503|504)\b/i.test(stderr);
  return { message, retryable };
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
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return { ok: true, changed: false };
    try {
      await execFileAsync(gitBin, ["-C", cacheRepoPath, "fetch", "--quiet", "--prune", "origin"], {
        timeout: CACHE_FETCH_TIMEOUT_MS,
        signal,
        env: gitEnv,
      });
      break;
    } catch (err) {
      if (signal?.aborted) return { ok: true, changed: false };
      const { message, retryable } = describeGitFailure(err, CACHE_FETCH_TIMEOUT_MS);
      if (!retryable || attempt === 2) {
        return { ok: false, changed: false, error: attempt === 2 ? `${message} (after 2 attempts)` : message };
      }
      try {
        await delay(CACHE_FETCH_RETRY_DELAY_MS, undefined, { signal });
      } catch (err) {
        if (signal?.aborted) return { ok: true, changed: false };
        throw err;
      }
    }
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
      return { ok: false, changed: false, error: describeGitFailure(err).message };
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
  mode?: string;
  hasUI?: boolean;
  modelRegistry?: ModelRegistryLike;
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

function findAddedPackageNames(
  agentDir: string,
  nextPackages: PackageSource[] | undefined,
  activeLocalHubId?: string,
  prevLocalHubId?: string,
): string[] {
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
  if (activeLocalHubId && prevIds.has(CANON_SELF_PACKAGE_ID)) {
    prevIds.add(activeLocalHubId);
  }
  if (prevLocalHubId && prevIds.has(prevLocalHubId)) {
    prevIds.add(CANON_SELF_PACKAGE_ID);
  }
  return nextPackages
    .filter((p) => !prevIds.has(normalizePackageIdentity(p, agentDir)))
    .map((p) => formatShortPackageName(p));
}

const TERM_MOD_SHIFT = 1;
const TERM_MOD_ALT = 2;
const TERM_MOD_CTRL = 4;
const TERM_MOD_SUPER = 8;
const TERM_LOCK_MASK = 64 | 128; // CapsLock (64) + NumLock (128)
const TERM_CHORD_MASK = TERM_MOD_ALT | TERM_MOD_CTRL | TERM_MOD_SUPER;

const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/;
const KITTY_CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

function normalizeChordCodepoint(codepoint: number, cleanMod: number): number {
  if ((cleanMod & TERM_CHORD_MASK) === 0) {
    return codepoint;
  }
  let cp = codepoint;
  if (cp === 0x3000) {
    cp = 0x20;
  } else if (cp >= 0xff01 && cp <= 0xff5e) {
    cp -= 0xfee0;
  }
  if ((cleanMod & TERM_MOD_SHIFT) === 0 && cp >= 65 && cp <= 90) {
    cp += 32;
  }
  return cp;
}

export function normalizeTerminalInputSequence(data: string): string {
  if (!data.startsWith("\x1b[") || data.startsWith("\x1b[200~")) {
    return data;
  }

  const mokMatch = MODIFY_OTHER_KEYS_RE.exec(data);
  if (mokMatch) {
    const modValue = Number(mokMatch[1]);
    const origCp = Number(mokMatch[2]);
    if (!Number.isSafeInteger(modValue) || modValue < 1 || !Number.isSafeInteger(origCp)) {
      return data;
    }
    const rawMod = modValue - 1;
    const cleanMod = rawMod & ~TERM_LOCK_MASK;
    const cp = normalizeChordCodepoint(origCp, cleanMod);
    if (cleanMod === 0) {
      if (cp === 13) return "\r";
      if (cp === 9) return "\t";
      if (cp >= 32 && cp !== 127 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
        return String.fromCodePoint(cp);
      }
    }
    if (cleanMod === rawMod && cp === origCp) {
      return data;
    }
    return `\x1b[27;${cleanMod + 1};${cp}~`;
  }

  const kittyMatch = KITTY_CSI_U_RE.exec(data);
  if (kittyMatch) {
    const modStr = kittyMatch[4];
    if (modStr === undefined) {
      return data;
    }
    const origCp = Number(kittyMatch[1]);
    const modValue = Number(modStr);
    if (!Number.isSafeInteger(origCp) || !Number.isSafeInteger(modValue) || modValue < 1) {
      return data;
    }
    const rawMod = modValue - 1;
    const cleanMod = rawMod & ~TERM_LOCK_MASK;
    const cp = normalizeChordCodepoint(origCp, cleanMod);
    const shiftedPart = kittyMatch[2];
    const origBasePart = kittyMatch[3];
    let nextBasePart = origBasePart;
    if (origBasePart !== undefined) {
      const origBaseCp = Number(origBasePart);
      if (Number.isSafeInteger(origBaseCp)) {
        nextBasePart = String(normalizeChordCodepoint(origBaseCp, cleanMod));
      }
    }
    if (cleanMod === rawMod && cp === origCp && nextBasePart === origBasePart) {
      return data;
    }
    const altSuffix =
      nextBasePart !== undefined
        ? `:${shiftedPart ?? ""}:${nextBasePart}`
        : shiftedPart !== undefined
          ? `:${shiftedPart}`
          : "";
    const eventSuffix = kittyMatch[5] !== undefined ? `:${kittyMatch[5]}` : "";
    return `\x1b[${cp}${altSuffix};${cleanMod + 1}${eventSuffix}u`;
  }

  return data;
}

export function handleStewardTerminalInput(data: string): { data: string } | undefined {
  const normalized = normalizeTerminalInputSequence(data);
  return normalized === data ? undefined : { data: normalized };
}

export default function (pi: ExtensionAPI) {
  const agentDir = resolveDefaultAgentDir();
  const packageRepoRoot = path.resolve(MODULE_DIR, "..");
  let activeSyncAbort: AbortController | undefined;
  let startupSyncTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;

  const clearTerminalInputNormalizer = () => {
    if (unsubscribeTerminalInput) {
      unsubscribeTerminalInput();
      unsubscribeTerminalInput = undefined;
    }
  };

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
        const prevState = readSyncState(agentDir);
        const prevLocalHubId = prevState.lastSyncedLocalHubPackage;
        const probe = createProviderVisibilityProbe(ctx.modelRegistry);
        const isTui = ctx.mode === "tui";
        const planned = computeStewardDiff(packageRepoRoot, agentDir, {
          syncModels: isTui && Boolean(probe),
          getProviderVisibility: probe,
        });
        const recordLoginGuide = isTui && ctx.hasUI && !prevState.loginGuideShown && planned.missingAuthProviders.length > 0;
        if (!planned.hasContentChanges && !planned.syncStateChanged && !planned.hasPendingSettings && !recordLoginGuide) return false;
        const result = await applyStewardDiff(planned, agentDir, { recordLoginGuide });
        if (!result.applied || !result.actualDiff) {
          const message = result.conflict
            ? "检测到设置同时更改；保留现有设置，本轮同步停止。"
            : result.settingsWritten ? "设置已落盘，待下次同步恢复状态。" : "本轮设置同步停止。";
          notifyCtx(ctx, `pi-steward: ${message}${result.lockError ? ` ${result.lockError}` : ""}`, "warning");
          return false;
        }
        const diff = result.actualDiff;
        const changed = diff.hasContentChanges || result.settingsWritten;
        if (changed) {
          const addedPkgs = diff.settingsChanged ? findAddedPackageNames(
            agentDir, diff.mergedSettings.packages, diff.nextSyncState.lastSyncedLocalHubPackage, prevLocalHubId,
          ) : [];
          const idLabel = diff.machineId ?? "read-only";
          const pkgHint = addedPkgs.length > 0 ? `（新增插件 ${addedPkgs.join(", ")} 将在下次启动或 /reload 时下载安装）` : "";
          const actionHint = diff.enabledModelsChanged
            ? addedPkgs.length > 0 ? "执行 /reload 后再 /new（或重启 Pi）生效。" : "执行 /new 或重启 Pi 使模型列表生效。"
            : "执行 /reload 或重启 Pi 生效。";
          notifyCtx(ctx, `pi-steward 已同步全局配置（${idLabel}）${pkgHint}，${actionHint}`, "info");
        }
        if (result.loginGuideProviders?.length) {
          notifyCtx(ctx, `pi-steward: Canon 模型涉及尚未登录的厂商（${result.loginGuideProviders.join(", ")}）；可按需执行 /login 补登，补登后执行 /reload 再 /new（或重启 Pi）生效，跳过即可，随时可用 /hub-status 复看。`, "info");
        }
        return changed;
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
      const syncCache = !hubRepoPath;
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
    clearTerminalInputNormalizer();
    cancelBackgroundSync();
  });

  pi.on("session_start", async (event, ctx) => {
    clearTerminalInputNormalizer();
    if (ctx.mode === "tui" && typeof ctx.ui?.onTerminalInput === "function") {
      unsubscribeTerminalInput = ctx.ui.onTerminalInput(handleStewardTerminalInput);
    }
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
        const probe = createProviderVisibilityProbe(ctx.modelRegistry);
        const diff = computeStewardDiff(packageRepoRoot, agentDir, {
          syncModels: ctx.mode === "tui" && Boolean(probe),
          getProviderVisibility: probe,
        });
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
          await execFileAsync(gitBin, ["-C", candidate, "config", "branch.master.rebase", "true"]);
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

      const markerWithLegacy: MachineMarker = {
        ...existing,
        machineId,
        ...(resolvedHubPath ? { hubRepoPath: resolvedHubPath } : {}),
      };
      const markerPath = path.join(agentDir, "machine.json");
      atomicWriteFileSync(markerPath, JSON.stringify(markerWithLegacy, null, 2) + "\n");
      const probe = createProviderVisibilityProbe(ctx.modelRegistry);
      const diff = computeStewardDiff(packageRepoRoot, agentDir, {
        syncModels: ctx.mode === "tui" && Boolean(probe),
        getProviderVisibility: probe,
      });
      const applyRes = await applyStewardDiff(diff, agentDir);
      if (!applyRes.applied) {
        notifyCtx(ctx, `已保存机器身份，设置同步暂未完成：${applyRes.lockError ?? "检测到设置同时更改"}`, "warning");
        return;
      }
      if (markerWithLegacy.lastSyncedCanonPackages !== undefined || markerWithLegacy.lastSyncedCanonModels !== undefined) {
        const cleanedMarker: MachineMarker = { ...markerWithLegacy };
        delete cleanedMarker.lastSyncedCanonPackages;
        if (Array.isArray(readSyncState(agentDir).seenVisibleCanon)) {
          delete cleanedMarker.lastSyncedCanonModels;
        }
        atomicWriteFileSync(markerPath, JSON.stringify(cleanedMarker, null, 2) + "\n");
      }
      notifyCtx(
        ctx,
        `已初始化机器 ${machineId}${resolvedHubPath ? `（可写工作仓 ${shortenHome(resolvedHubPath)}，隐私钩子已启用）` : "（只读同步节点）"}`,
        "info",
      );
    },
  });
}

