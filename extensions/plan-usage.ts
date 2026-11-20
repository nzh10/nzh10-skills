/**
 * Show coding-plan quota immediately before the footer model name.
 *
 * Active only for the current model:
 *   zai-coding-cn  → 5h / weekly token windows
 *   openai-codex   → ChatGPT 5h / weekly windows
 *   xai            → SuperGrok monthly / weekly (may fail on built-in xAI OAuth)
 *   kimi-coding    → Kimi for Coding weekly / 5h / monthly windows
 *
 * DeepSeek / Gemini and other API-key models keep the default right side.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PLAN_PROVIDERS = new Set(["zai-coding-cn", "openai-codex", "xai", "kimi-coding"]);
const CACHE_TTL_MS = 60_000;
const MIN_FETCH_GAP_MS = 30_000;
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const ZAI_CN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

type Theme = ExtensionContext["ui"]["theme"];

type UsageWindow = {
	label: string;
	usedPercent: number;
};

type UsageSnapshot = {
	provider: string;
	windows: UsageWindow[];
	fetchedAt: number;
};

const cache = new Map<string, UsageSnapshot>();
const failedAt = new Map<string, number>();
let inFlight: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastCtx: ExtensionContext | undefined;
let capturedTui: { requestRender(): void } | undefined;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function clampPercent(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, n));
}

function windowLabel(seconds: number): string {
	if (seconds >= 6 * 24 * 3600) return "wk";
	if (seconds >= 23 * 3600) return "d";
	if (seconds >= 4 * 3600) return `${Math.round(seconds / 3600)}h`;
	if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
	return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function moneyish(value: unknown): number | undefined {
	const direct = asNumber(value);
	if (direct !== undefined) return direct;
	const rec = asRecord(value);
	return rec ? asNumber(rec.val) : undefined;
}

// Kimi returns limit/used/remaining as numeric strings ("100", "4").
function num(value: unknown): number | undefined {
	const direct = asNumber(value);
	if (direct !== undefined) return direct;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

async function providerToken(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (key?.trim()) return key.trim();
	} catch {
		// fall through to stored credential
	}
	const stored = readStoredCredential(provider) as
		| { key?: string; access?: string }
		| undefined;
	const fallback = stored?.key ?? stored?.access;
	return typeof fallback === "string" && fallback.trim() ? fallback.trim() : undefined;
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		return asRecord(payload);
	} catch {
		return undefined;
	}
}

async function fetchZaiUsage(ctx: ExtensionContext): Promise<UsageWindow[] | undefined> {
	const token = await providerToken(ctx, "zai-coding-cn");
	if (!token) return undefined;
	const payload = await fetchJson(ZAI_CN_QUOTA_URL, {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Accept-Language": "en-US,en",
	});
	const data = asRecord(payload?.data);
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const windows: UsageWindow[] = [];
	for (const item of limits) {
		const limit = asRecord(item);
		if (!limit) continue;
		// China coding plan currently returns CREDIT_LIMIT; global docs/examples use TOKENS_LIMIT.
		if (limit.type !== "CREDIT_LIMIT" && limit.type !== "TOKENS_LIMIT") continue;
		const unit = asNumber(limit.unit);
		const percentage = asNumber(limit.percentage);
		if (percentage === undefined) continue;
		if (unit === 3) windows.push({ label: "5h", usedPercent: clampPercent(percentage) });
		if (unit === 6) windows.push({ label: "wk", usedPercent: clampPercent(percentage) });
	}
	return windows.length > 0 ? windows : undefined;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<UsageWindow[] | undefined> {
	const token = await providerToken(ctx, "openai-codex");
	if (!token) return undefined;
	const stored = readStoredCredential("openai-codex") as { accountId?: string } | undefined;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		originator: "codex_cli_rs",
	};
	if (stored?.accountId) headers["chatgpt-account-id"] = stored.accountId;
	const payload = await fetchJson(CODEX_USAGE_URL, headers);
	if (!payload) return undefined;
	const rateLimit = asRecord(payload.rate_limit);
	const windows: UsageWindow[] = [];
	for (const key of ["secondary_window", "primary_window"] as const) {
		const window = rateLimit ? asRecord(rateLimit[key]) : undefined;
		if (!window) continue;
		const usedPercent = asNumber(window.used_percent);
		const windowSeconds = asNumber(window.limit_window_seconds);
		if (usedPercent === undefined || windowSeconds === undefined) continue;
		windows.push({
			label: windowLabel(windowSeconds),
			usedPercent: clampPercent(usedPercent),
		});
	}
	return windows.length > 0 ? windows : undefined;
}

async function fetchXaiUsage(ctx: ExtensionContext): Promise<UsageWindow[] | undefined> {
	const token = await providerToken(ctx, "xai");
	if (!token) return undefined;
	const headers = {
		authorization: `Bearer ${token}`,
		"x-xai-token-auth": "xai-grok-cli",
		"x-grok-client-version": "0.2.101",
		"x-grok-client-mode": "interactive",
		accept: "application/json",
	};
	const monthlyPayload = await fetchJson(XAI_BILLING_URL, headers);
	const config = asRecord(monthlyPayload?.config);
	const monthlyLimit = moneyish(config?.monthlyLimit);
	const used = moneyish(config?.used);
	const windows: UsageWindow[] = [];
	if (monthlyLimit !== undefined && used !== undefined) {
		const usedPercent = monthlyLimit > 0 ? (used / monthlyLimit) * 100 : used > 0 ? 100 : 0;
		windows.push({ label: "mo", usedPercent: clampPercent(usedPercent) });
	}
	const weeklyPayload = await fetchJson(`${XAI_BILLING_URL}?format=credits`, headers);
	const weeklyConfig = asRecord(weeklyPayload?.config);
	const weeklyPercent = asNumber(weeklyConfig?.creditUsagePercent);
	if (weeklyPercent !== undefined) {
		windows.push({ label: "wk", usedPercent: clampPercent(weeklyPercent) });
	}
	return windows.length > 0 ? windows : undefined;
}

async function fetchKimiUsage(ctx: ExtensionContext): Promise<UsageWindow[] | undefined> {
	const token = await providerToken(ctx, "kimi-coding");
	if (!token) return undefined;
	const payload = await fetchJson(KIMI_USAGE_URL, {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	});
	if (!payload) return undefined;
	const windows: UsageWindow[] = [];
	const push = (label: string, usedPercent: number) => {
		if (windows.some((w) => w.label === label)) return;
		windows.push({ label, usedPercent: clampPercent(usedPercent) });
	};
	const percentOf = (data: Record<string, unknown>): number | undefined => {
		const limit = num(data.limit);
		let used = num(data.used);
		const remaining = num(data.remaining);
		if (used === undefined && limit !== undefined && remaining !== undefined) {
			used = limit - remaining;
		}
		if (used === undefined || limit === undefined) return undefined;
		return limit > 0 ? (used / limit) * 100 : used > 0 ? 100 : 0;
	};
	// Weekly summary row (per kimi-cli); absent on the monthly plan.
	const summary = asRecord(payload.usage);
	if (summary) {
		const pct = percentOf(summary);
		if (pct !== undefined) push("wk", pct);
	}
	// Timed windows: {window: {duration: 300, timeUnit: "TIME_UNIT_MINUTE"}, detail: {...}}
	const limits = Array.isArray(payload.limits) ? payload.limits : [];
	for (const item of limits) {
		const entry = asRecord(item);
		if (!entry) continue;
		const detail = asRecord(entry.detail) ?? entry;
		const win = asRecord(entry.window);
		const duration = num(win?.duration ?? entry.duration ?? detail.duration);
		const timeUnit = String(
			win?.timeUnit ?? entry.timeUnit ?? detail.timeUnit ?? "",
		).toUpperCase();
		if (duration === undefined || duration <= 0) continue;
		const seconds = timeUnit.includes("MINUTE")
			? duration * 60
			: timeUnit.includes("HOUR")
				? duration * 3600
				: timeUnit.includes("DAY")
					? duration * 86400
					: duration;
		const pct = percentOf(detail);
		if (pct !== undefined) push(windowLabel(seconds), pct);
	}
	// Ratio summaries: usages: {limit_5h: {used_ratio}, limit_month_total: {used_ratio}, ...}
	const usages = asRecord(payload.usages);
	let monthRatio = num(asRecord(usages?.limit_month_total)?.used_ratio);
	if (monthRatio === undefined) {
		for (const [key, value] of Object.entries(usages ?? {})) {
			if (!key.includes("month")) continue;
			monthRatio = num(asRecord(value)?.used_ratio);
			if (monthRatio !== undefined) break;
		}
	}
	if (monthRatio !== undefined) push("mo", monthRatio * 100);
	return windows.length > 0 ? windows : undefined;
}

async function fetchProviderUsage(
	ctx: ExtensionContext,
	provider: string,
): Promise<UsageWindow[] | undefined> {
	if (provider === "zai-coding-cn") return fetchZaiUsage(ctx);
	if (provider === "openai-codex") return fetchCodexUsage(ctx);
	if (provider === "xai") return fetchXaiUsage(ctx);
	if (provider === "kimi-coding") return fetchKimiUsage(ctx);
	return undefined;
}

function currentSnapshot(provider: string | undefined): UsageSnapshot | undefined {
	if (!provider) return undefined;
	const snap = cache.get(provider);
	if (!snap) return undefined;
	// Keep last good snapshot even if slightly stale; fetch refreshes in background.
	return snap;
}

async function refreshUsage(ctx: ExtensionContext, force = false): Promise<void> {
	const provider = ctx.model?.provider;
	if (!provider || !PLAN_PROVIDERS.has(provider)) return;
	const now = Date.now();
	const snap = cache.get(provider);
	const lastFail = failedAt.get(provider) ?? 0;
	if (!force && snap && now - snap.fetchedAt < CACHE_TTL_MS) return;
	if (!force && !snap && now - lastFail < MIN_FETCH_GAP_MS) return;
	if (inFlight === provider) return;
	inFlight = provider;
	try {
		const windows = await fetchProviderUsage(ctx, provider);
		if (windows && windows.length > 0) {
			cache.set(provider, { provider, windows, fetchedAt: now });
			failedAt.delete(provider);
		} else {
			failedAt.set(provider, now);
		}
		capturedTui?.requestRender();
	} finally {
		inFlight = undefined;
	}
}

function usageColor(theme: Theme, usedPercent: number): string {
	if (usedPercent >= 90) return "error";
	if (usedPercent >= 70) return "warning";
	return "success";
}

function formatUsage(
	theme: Theme,
	snap: UsageSnapshot | undefined,
): { plain: string; colored: string } | undefined {
	if (!snap || snap.windows.length === 0) return undefined;
	const parts = snap.windows.map((window) => {
		const pct = `${Math.round(window.usedPercent)}%`;
		return {
			plain: `${window.label} ${pct}`,
			colored: `${window.label} ${theme.fg(usageColor(theme, window.usedPercent), pct)}`,
		};
	});
	return {
		plain: parts.map((part) => part.plain).join(" · "),
		colored: parts.map((part) => part.colored).join(" · "),
	};
}

function collectSessionTotals(ctx: ExtensionContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage =
			entry.type === "message" &&
			(entry.message.role === "assistant" || entry.message.role === "toolResult")
				? entry.message.usage
				: entry.type === "branch_summary" || entry.type === "compaction"
					? entry.usage
					: undefined;
		if (!usage) continue;
		input += usage.input || 0;
		output += usage.output || 0;
		cacheRead += usage.cacheRead || 0;
		cacheWrite += usage.cacheWrite || 0;
		cost += usage.cost?.total || 0;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			latestCacheHitRate = prompt > 0 ? ((usage.cacheRead || 0) / prompt) * 100 : undefined;
		}
	}
	return { input, output, cacheRead, cacheWrite, cost, latestCacheHitRate };
}

function renderFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
): string[] {
	const totals = collectSessionTotals(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent =
		contextUsage?.percent !== null && contextUsage?.percent !== undefined
			? contextPercentValue.toFixed(1)
			: "?";

	let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	const statsParts: string[] = [];
	if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestCacheHitRate !== undefined) {
		statsParts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
	}

	const provider = ctx.model?.provider;
	const usingSubscription = Boolean(provider && (PLAN_PROVIDERS.has(provider) || provider === "kimi-coding"));
	if (totals.cost || usingSubscription) {
		statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}

	const autoIndicator = " (auto)";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
	let contextPercentStr: string;
	if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
	else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
	else contextPercentStr = contextPercentDisplay;
	statsParts.push(contextPercentStr);

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = ctx.model?.id || "no-model";
	let modelSide = modelName;
	if (ctx.model?.reasoning) {
		const thinkingLevel = ctx.thinkingLevel || "off";
		modelSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}

	let providerPrefix = "";
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		providerPrefix = `(${ctx.model.provider}) `;
	}

	const usage = formatUsage(theme, currentSnapshot(provider));
	let modelRight = `${providerPrefix}${modelSide}`;
	const usagePlain = usage?.plain ?? "";
	const usageGap = usagePlain ? "  " : "";

	const minPadding = 2;
	let usageShown = Boolean(usage);
	let usageBlockWidth = usageShown ? visibleWidth(usagePlain) + visibleWidth(usageGap) : 0;
	if (
		providerPrefix &&
		statsLeftWidth + minPadding + usageBlockWidth + visibleWidth(modelRight) > width
	) {
		modelRight = modelSide;
	}

	let modelWidth = visibleWidth(modelRight);
	const roomForRight = width - statsLeftWidth;
	if (roomForRight < minPadding) {
		usageShown = false;
		usageBlockWidth = 0;
		modelRight = "";
		modelWidth = 0;
	} else if (statsLeftWidth + minPadding + usageBlockWidth + modelWidth > width) {
		const availableForModel = width - statsLeftWidth - minPadding - usageBlockWidth;
		if (availableForModel > 0) {
			modelRight = truncateToWidth(modelRight, availableForModel, "");
			modelWidth = visibleWidth(modelRight);
		} else {
			modelRight = "";
			modelWidth = 0;
			if (usageShown && statsLeftWidth + minPadding + visibleWidth(usagePlain) > width) {
				usageShown = false;
				usageBlockWidth = 0;
			}
		}
	}

	const paddingWidth =
		modelWidth + usageBlockWidth === 0
			? 0
			: Math.max(minPadding, width - statsLeftWidth - usageBlockWidth - modelWidth);
	const padding = " ".repeat(paddingWidth);
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const rightColored =
		(usageShown && usage ? usage.colored + usageGap : "") +
		(modelRight ? theme.fg("dim", modelRight) : "");
	const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
	const lines = [pwdLine, dimStatsLeft + padding + rightColored];

	const extensionStatuses = footerData.getExtensionStatuses();
	if (extensionStatuses.size > 0) {
		const statusLine = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
	}
	return lines;
}

function setupFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		capturedTui = tui;
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsub,
			invalidate() {},
			render: (width: number) => renderFooter(ctx, theme, footerData, width),
		};
	});
}

function startTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		if (lastCtx) void refreshUsage(lastCtx);
	}, REFRESH_MS);
	if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") return;
		setupFooter(ctx);
		void refreshUsage(ctx, true);
		startTimer();
	});

	pi.on("model_select", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") return;
		void refreshUsage(ctx, true);
		capturedTui?.requestRender();
	});

	pi.on("turn_end", (_event, ctx) => {
		lastCtx = ctx;
		void refreshUsage(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		lastCtx = undefined;
		capturedTui = undefined;
	});
}
