import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const PROVIDER = "deepseek";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_500;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PREVIEW_BYTES = 8_000;
const CONTENT_PREVIEW_CHARS = 600;
const CIMI_BASE_URL = "https://api.cimidata.com";
const CIMI_TIMEOUT_MS = 20_000;
const CIMI_COST_YUAN = { wechat: 0.05, library: 0.02 } as const;
type CimiScope = keyof typeof CIMI_COST_YUAN;
const QOVIA_BASE_URL = "https://api.qovia.ai";
const QOVIA_TIMEOUT_MS = 20_000;
type SocialPlatform = "xiaohongshu" | "douyin";
interface CimiConfig { app_id: string; app_secret: string; source: string }
interface CimiItem { content_url: string; title: string; published_at?: string; nickname?: string; username?: string; cover?: string }
interface CimiEvidence { query: string; scope: CimiScope; page: number; items: CimiItem[]; retrievedAt: string; fullOutputPath: string; recordPath: string }
const STATUS_HINTS: Record<number, string> = {
	400: "上游认为请求不合法", 401: "检查 DeepSeek 凭据", 402: "账户余额不足",
	403: "上游接口拒绝请求；仅凭此码不能确定目标站点的拒绝原因",
	404: "抓取服务未取得内容；不能据此断定目标网页本身返回404",
	408: "上游请求超时", 413: "请求体过大", 429: "上游限流", 500: "上游内部错误", 504: "上游网关超时",
};

type Kind = "search" | "fetch";
type Request = Record<string, unknown>;
interface SearchResult {
	rerank_score?: number; title: string; url: string; snippet?: string; summary?: string;
	content?: string; site_name?: string | null; date?: string | null; authority?: number;
}
interface Evidence {
	version: 2; kind: Kind; key: string; request: Request; data: any; retrievedAt: string;
	fullOutputPath: string; recordPath: string;
}
interface Details {
	version?: 2; query?: string; url?: string; title?: string; count?: number; cached?: boolean;
	apiRequests: number; estimatedCostYuan?: number; chargedUsd?: number; platform?: string; retrievedAt?: string; truncated?: boolean;
	fullOutputPath?: string; recordPath?: string; contentStatus?: string; error?: string;
}
function keyFor(kind: Kind, request: Request): string {
	return JSON.stringify([BASE_URL, kind, request]);
}
function fingerprint(r: SearchResult, withContent: boolean): string {
	return createHash("sha256").update(JSON.stringify([r.title, r.snippet, r.date, withContent ? r.content : ""])).digest("hex");
}
function meta(r: SearchResult): string {
	return [r.site_name, r.date?.slice(0, 10), r.authority != null && r.authority >= 0 ? `权威 ${r.authority}/4` : null,
		typeof r.rerank_score === "number" ? `评分 ${r.rerank_score.toFixed(3)}` : null].filter(Boolean).join(" · ");
}
function fullText(kind: Kind, request: Request, data: any): string {
	if (kind === "fetch") return `URL: ${request.url}\n# ${data.title || request.url}\n\n${data.content ?? ""}`;
	return `Query: ${request.query}\n\n` + data.results.map((r: SearchResult, i: number) =>
		`--- Result ${i + 1} ---\nTitle: ${r.title}\nLink: ${r.url}\nMeta: ${meta(r)}\nSnippet: ${r.snippet ?? ""}` +
		(r.content ? `\nContent (API返回的内容，不保证网页完整):\n${r.content}` : "")).join("\n\n");
}
function pageHint(title: string, content: string): string {
	if (!content.trim()) return "empty";
	if (content.length < 1500 && /当前环境异常[\s\S]{0,40}验证|登录后你可以|您查看的页面无法访问|返回首页试听以下|access denied|just a moment/i.test(title + "\n" + content)) return "access_hint";
	return "text"; // Obtained text, not a claim that an article was verified.
}
function validateData(kind: Kind, data: any): void {
	if (kind === "search") {
		if (!Array.isArray(data?.results) || data.results.some((r: any) => typeof r?.title !== "string" || typeof r?.url !== "string" ||
			(r.content != null && typeof r.content !== "string") || (r.snippet != null && typeof r.snippet !== "string"))) throw new Error("搜索接口响应结构异常，不能当作无结果");
	} else if (!data || typeof data !== "object" || typeof data.content !== "string" || (data.title != null && typeof data.title !== "string")) {
		throw new Error("抓取接口响应结构异常，未得到可读取的content字段");
	}
}
async function callApi(ctx: ExtensionContext, kind: Kind, body: Request, signal?: AbortSignal) {
	let apiRequests = 0;
	try {
		signal?.throwIfAborted();
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!key) throw new Error("没有可用的 DeepSeek API key；使用 /login deepseek 或 DEEPSEEK_API_KEY。");
		for (let attempt = 0; attempt < 2; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			apiRequests++;
			const response = await fetch(`${BASE_URL}/v1/tools/${kind}`, {
				method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
				await response.body?.cancel();
				await delay(RETRY_DELAY_MS, undefined, { signal });
				continue;
			}
			if (!response.ok) {
				const raw = await response.text(); let detail = raw;
				try { detail = JSON.parse(raw)?.error?.message ?? raw; } catch { /* preserve non-JSON errors */ }
				throw new Error(`DeepSeek /v1/tools/${kind} 返回 HTTP ${response.status}: ${String(detail).slice(0, 500)}${STATUS_HINTS[response.status] ? `（${STATUS_HINTS[response.status]}）` : ""}`);
			}
			const data = await response.json(); validateData(kind, data);
			return { data, apiRequests };
		}
		throw new Error("上游请求未完成");
	} catch (cause) {
		throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { apiRequests });
	}
}
async function persist(kind: Kind, request: Request, data: any): Promise<Evidence> {
	const dir = await mkdtemp(join(tmpdir(), "pi-ds-evidence-"));
	const evidence: Evidence = { version: 2, kind, key: keyFor(kind, request), request, data,
		retrievedAt: new Date().toISOString(), fullOutputPath: join(dir, "output.md"), recordPath: join(dir, "response.json") };
	await withFileMutationQueue(evidence.recordPath, async () => {
		await writeFile(evidence.fullOutputPath, fullText(kind, request, data), "utf8");
		await writeFile(evidence.recordPath, JSON.stringify(evidence), "utf8");
	});
	return evidence;
}
function finish(raw: string, details: Details) {
	const capped = truncateHead(raw, { maxBytes: PREVIEW_BYTES, maxLines: 300 });
	details.truncated = !!details.truncated || capped.truncated;
	const tail = details.fullOutputPath ? `\n\n${details.truncated ? "[预览已截断] " : ""}完整API返回内容（可用read分段读取）: ${details.fullOutputPath}` : "";
	return { content: [{ type: "text" as const, text: capped.content + tail }], details };
}
async function readSearchConfig(cwd: string): Promise<{ path: string; data: any }> {
	const paths = [join(cwd, ".pi", "universal-search.json"), join(getAgentDir(), "universal-search.json")];
	for (const path of paths) {
		let raw: string;
		try { raw = await readFile(path, "utf8"); }
		catch (cause: any) { if (cause?.code === "ENOENT") continue; throw new Error(`读取 ${path} 失败：${cause?.message ?? cause}`); }
		try { return { path, data: JSON.parse(raw) }; } catch { throw new Error(`${path} 不是合法 JSON`); }
	}
	throw new Error(`没有找到配置文件：在 ${paths[0]}（当前项目）或 ${paths[1]}（全局）里按 vendor 分节填写凭据`);
}
async function readCimiConfig(cwd: string): Promise<CimiConfig> {
	const { path, data } = await readSearchConfig(cwd);
	const vendor = data?.cimidata;
	if (vendor == null) throw new Error(`${path} 缺少 cimidata 节`);
	const appId = vendor.app_id ?? vendor.appId, appSecret = vendor.app_secret ?? vendor.appSecret;
	if (typeof appId !== "string" || !appId.trim() || typeof appSecret !== "string" || !appSecret.trim())
		throw new Error(`${path} 的 cimidata 节缺少 app_id 或 app_secret`);
	return { app_id: appId.trim(), app_secret: appSecret.trim(), source: path };
}
const cimiTokens = new Map<string, { token: string; expiresAt: number }>();
async function cimiToken(config: CimiConfig, signal?: AbortSignal) {
	const cacheKey = createHash("sha256").update(config.app_id).digest("hex");
	const hit = cimiTokens.get(cacheKey);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
	const timeout = AbortSignal.timeout(CIMI_TIMEOUT_MS);
	const response = await fetch(`${CIMI_BASE_URL}/api/v2/token`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ app_id: config.app_id, app_secret: config.app_secret }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const raw = await response.text(); let body: any;
	try { body = JSON.parse(raw); } catch { body = null; }
	if (!response.ok) throw new Error(`次幂换 token 返回 HTTP ${response.status}: ${raw.slice(0, 300)}`);
	if (body?.code !== 200 || typeof body?.data?.access_token !== "string")
		throw new Error(`次幂换 token 失败（code ${body?.code ?? "?"}）：${body?.msg ?? "响应缺少 access_token"}${body?.code === 4102 ? "；检查 app_id 与 app_secret" : ""}`);
	cimiTokens.set(cacheKey, { token: body.data.access_token, expiresAt: Date.now() + 7 * 24 * 3600_000 });
	return body.data.access_token as string;
}
function cleanTitle(title: string) { return title.replace(/<[^>]+>/g, ""); }
async function cimiSearch(config: CimiConfig, scope: CimiScope, query: string, page: number, signal?: AbortSignal) {
	const token = await cimiToken(config, signal);
	const path = scope === "wechat" ? "/api/v3/articles/search" : "/api/v2/articles/search";
	const body = scope === "wechat" ? { keyword: query, page } : { keyword: query };
	const timeout = AbortSignal.timeout(CIMI_TIMEOUT_MS);
	let apiRequests = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		signal?.throwIfAborted(); apiRequests++;
		const response = await fetch(`${CIMI_BASE_URL}${path}`, {
			method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const raw = await response.text(); let data: any;
		try { data = JSON.parse(raw); } catch { data = null; }
		if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
			await delay(1_500, undefined, { signal }); continue;
		}
		if (!response.ok) throw new Error(`次幂 ${path} 返回 HTTP ${response.status}: ${raw.slice(0, 300)}`);
		if (data?.code === 1004) return { items: [] as CimiItem[], apiRequests, empty: true };
		if (data?.code !== 200) {
			const hint = data?.code === 6020 ? "；余额不足" : data?.code === 4102 ? "；检查 app_id 与 app_secret" : "";
			throw Object.assign(new Error(`次幂 ${path} 返回 code ${data?.code ?? "?"}：${data?.msg ?? "响应结构异常"}${hint}`), { apiRequests });
		}
		const items = data?.data?.items;
		if (!Array.isArray(items) || items.some((item: any) => typeof item?.content_url !== "string" || typeof item?.title !== "string"))
			throw Object.assign(new Error("次幂搜索响应结构异常，不能当作无结果"), { apiRequests });
		return { items: items as CimiItem[], apiRequests, empty: false };
	}
	throw Object.assign(new Error("次幂请求未完成"), { apiRequests });
}
async function persistCimi(scope: CimiScope, query: string, page: number, items: CimiItem[]): Promise<CimiEvidence> {
	const dir = await mkdtemp(join(tmpdir(), "pi-cimi-evidence-"));
	const evidence: CimiEvidence = { query, scope, page, items, retrievedAt: new Date().toISOString(),
		fullOutputPath: join(dir, "output.md"), recordPath: join(dir, "response.json") };
	await withFileMutationQueue(evidence.recordPath, async () => {
		await writeFile(evidence.fullOutputPath, `Query: ${query}\nScope: ${scope}\n\n` + items.map((item, i) =>
			`--- Result ${i + 1} ---\nTitle: ${cleanTitle(item.title)}\nLink: ${item.content_url}` +
			(item.nickname ? `\nAccount: ${item.nickname}` : "") + (item.published_at ? `\nPublished: ${item.published_at}` : "")).join("\n\n"), "utf8");
		await writeFile(evidence.recordPath, JSON.stringify(evidence), "utf8");
	});
	return evidence;
}
interface SocialEvidence {
	key: string; kind: "search" | "fetch"; platform: SocialPlatform | "bilibili"; request: Record<string, unknown>;
	data: any; chargedUsd: number; retrievedAt: string; fullOutputPath: string; recordPath: string;
}
const QOVIA_PRICE = { "douyin.search": 0.0005, "xiaohongshu.search": 0.005, "douyin.video": 0.0005, "xiaohongshu.note": 0.005, "bilibili.video": 0.0005 } as const;
const douyinPages = new Map<string, { searchId: string; cursor: number; page: number }>();
async function readQoviaKey(cwd: string): Promise<{ key: string; path: string }> {
	const { path, data } = await readSearchConfig(cwd);
	const key = data?.qovia?.api_key ?? data?.qovia?.apiKey;
	if (typeof key !== "string" || !key.trim()) throw new Error(`${path} 的 qovia 节缺少 api_key`);
	return { key: key.trim(), path };
}
async function qoviaGet(key: string, path: string, params: Record<string, unknown>, signal?: AbortSignal) {
	const url = new URL(`${QOVIA_BASE_URL}${path}`);
	for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
	const timeout = AbortSignal.timeout(QOVIA_TIMEOUT_MS);
	const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	const raw = await response.text(); let body: any;
	try { body = JSON.parse(raw); } catch { body = null; }
	if (!response.ok || body?.error) {
		const code = body?.error?.code ?? `HTTP ${response.status}`;
		const hint = code === "insufficient_balance" ? "；余额不足" : code === "scope_denied" ? "；这把 key 没有该接口的 scope" : code === "invalid_params" ? "；参数被拒绝" : "";
		throw new Error(`Qovia ${path} 失败（${code}）：${body?.error?.message ?? raw.slice(0, 300)}${hint}`);
	}
	return { data: body?.data, chargedUsd: typeof body?.meta?.charged_usd === "number" ? body.meta.charged_usd : 0 };
}
async function socialSearch(key: string, platform: SocialPlatform, query: string, page: number, sort: string | undefined, signal?: AbortSignal) {
	if (platform === "xiaohongshu") return qoviaGet(key, "/v1/raw/xiaohongshu/search", { keyword: query, page, sort }, signal);
	if (page === 1) {
		const result = await qoviaGet(key, "/v1/raw/douyin/search", { keyword: query, count: 20 }, signal);
		const searchId = result.data?.search_id, cursor = result.data?.cursor;
		if (typeof searchId === "string" && typeof cursor === "number") douyinPages.set(query, { searchId, cursor, page: 1 });
		return result;
	}
	const state = douyinPages.get(query);
	if (!state || state.page !== page - 1)
		throw new Error(`抖音翻页要先在同一次会话里搜第 1 页，再一页页往后；现在没有「${query}」第 ${page - 1} 页的记录`);
	const result = await qoviaGet(key, "/v1/raw/douyin/search", { keyword: query, cursor: state.cursor, search_id: state.searchId, count: 20 }, signal);
	const cursor = result.data?.cursor;
	if (typeof cursor === "number") douyinPages.set(query, { searchId: state.searchId, cursor, page });
	return result;
}
function socialRows(platform: SocialPlatform, data: any): Array<{ title: string; url: string; author?: string; meta: string }> {
	const items: any[] = Array.isArray(data?.items) ? data.items : [];
	if (platform === "douyin") return items.map(item => {
		const text = String(item?.text ?? item?.extra?.title ?? "").trim();
		const metrics = item?.metrics ?? {};
		return { title: text.split("\n")[0].slice(0, 80), url: item?.extra?.url ?? "", author: item?.author?.nickname,
			meta: [metrics.plays != null ? `${metrics.plays} 播放` : null, metrics.likes != null ? `${metrics.likes} 赞` : null,
				metrics.comments != null ? `${metrics.comments} 评` : null, item?.extra?.published_at?.slice(0, 10)].filter(Boolean).join(" · ") };
	});
	return items.flatMap(item => {
		const note = item?.model_type === "note" ? item?.note : null;
		if (!note?.id) return [];
		return [{ title: String(note.title ?? note.desc ?? "").split("\n")[0].slice(0, 80), url: `https://www.xiaohongshu.com/explore/${note.id}`,
			author: note.user?.nickname,
			meta: [note.liked_count != null ? `${note.liked_count} 赞` : null, note.comments_count != null ? `${note.comments_count} 评` : null,
				note.collected_count != null ? `${note.collected_count} 藏` : null, note.timestamp ? new Date(note.timestamp * 1000).toISOString().slice(0, 10) : null].filter(Boolean).join(" · ") }];
	});
}
function socialBody(platform: SocialPlatform | "bilibili", data: any) {
	if (platform === "bilibili") return { title: data?.extra?.title ?? "", author: data?.author?.name, text: data?.text ?? "",
		url: data?.extra?.url ?? `https://www.bilibili.com/video/${data?.extra?.source_id ?? ""}`, published: data?.extra?.published_at, metrics: data?.metrics };
	if (platform === "douyin") return { title: String(data?.text ?? "").split("\n")[0].slice(0, 80), author: data?.author?.nickname, text: data?.text ?? "",
		url: data?.extra?.url ?? `https://www.douyin.com/video/${data?.extra?.source_id ?? ""}`, published: data?.extra?.published_at, metrics: data?.metrics };
	return { title: data?.title ?? "", author: data?.user?.nick_name, text: data?.desc ?? "",
		url: "", published: data?.time ? new Date(data.time * 1000).toISOString() : "", metrics: data?.interact_info };
}
function parseSocialUrl(value: string) {
	let parsed: URL;
	try { parsed = new URL(value); } catch { throw new Error("url 需为 http(s) 作品链接"); }
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("url 需为 http(s) 作品链接");
	const text = parsed.href;
	if (/^(?:www\.)?bilibili\.com$/i.test(parsed.hostname)) {
		const match = text.match(/\/video\/(BV[0-9A-Za-z]+)/);
		if (match) return { platform: "bilibili" as const, id: match[1] };
	}
	if (/^(?:www\.)?douyin\.com$/i.test(parsed.hostname)) {
		const match = text.match(/\/(?:video|shipin)\/(\d+)/) ?? text.match(/[?&]modal_id=(\d+)/);
		if (match) return { platform: "douyin" as const, id: match[1] };
	}
	if (/^(?:www\.)?xiaohongshu\.com$/i.test(parsed.hostname)) {
		const match = text.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i);
		if (match) return { platform: "xiaohongshu" as const, id: match[1] };
	}
	if (/^(?:b23\.tv|v\.douyin\.com|xhslink\.com|www\.xhslink\.com)$/i.test(parsed.hostname))
		throw new Error("短链要先展开成标准作品链接再用");
	throw new Error("只认 B 站 /video/BV...、抖音 /video/<数字>、小红书 /explore/<24位> 这几类作品链接");
}
async function persistSocial(evidence: Omit<SocialEvidence, "retrievedAt" | "fullOutputPath" | "recordPath">): Promise<SocialEvidence> {
	const dir = await mkdtemp(join(tmpdir(), "pi-social-evidence-"));
	const full: SocialEvidence = { ...evidence, retrievedAt: new Date().toISOString(), fullOutputPath: join(dir, "output.md"), recordPath: join(dir, "response.json") };
	let text: string;
	if (evidence.kind === "search") {
		const rows = socialRows(evidence.platform as SocialPlatform, evidence.data);
		text = `Query: ${evidence.request.query}\nPlatform: ${evidence.platform}\n\n` + rows.map((row, i) =>
			`--- Result ${i + 1} ---\nTitle: ${row.title}\nLink: ${row.url}` + (row.author ? `\nAuthor: ${row.author}` : "") + (row.meta ? `\n${row.meta}` : "")).join("\n\n");
	} else {
		const body = socialBody(evidence.platform as SocialPlatform | "bilibili", evidence.data);
		text = `# ${body.title}\nURL: ${body.url}\nAuthor: ${body.author ?? ""}\nPublished: ${body.published ?? ""}\n\n${body.text}`;
	}
	await withFileMutationQueue(full.recordPath, async () => {
		await writeFile(full.fullOutputPath, text, "utf8");
		await writeFile(full.recordPath, JSON.stringify(full), "utf8");
	});
	return full;
}
function failure(error: unknown, input: { query?: string; url?: string }) {
	const message = error instanceof Error ? error.message : String(error);
	const apiRequests = (error as any)?.apiRequests ?? 0;
	return { isError: true, content: [{ type: "text" as const, text: `${message}\n本次API请求: ${apiRequests}；费用未核实。` }], details: { ...input, error: message, apiRequests } as Details };
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, Evidence>();
	const cimiCache = new Map<string, CimiEvidence>();
	const socialCache = new Map<string, SocialEvidence>();
	const inFlight = new Map<string, Promise<{ evidence: Evidence; apiRequests: number }>>();
	const seenEvidence = new Map<string, string>();
	let epoch = 0;
	const remember = (e: Evidence) => {
		cache.set(e.key, e);
		if (e.kind === "search") for (const r of e.data.results) seenEvidence.set(r.url, fingerprint(r, !!e.request.need_content));
	};
	const reconstruct = async (ctx: ExtensionContext) => {
		epoch++; cache.clear(); seenEvidence.clear(); inFlight.clear();
		const paths = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || !["web_search", "web_fetch"].includes(entry.message.toolName)) continue;
			const d = entry.message.details as Details | undefined;
			if (d?.version === 2 && d.recordPath) paths.add(d.recordPath);
		}
		for (const path of paths) {
			try {
				const e: Evidence = JSON.parse(await readFile(path, "utf8"));
				if (e.version !== 2 || !["search", "fetch"].includes(e.kind) || e.key !== keyFor(e.kind, e.request)) continue;
				validateData(e.kind, e.data); remember(e);
			} catch { /* Cleaned/missing artifacts are cache misses, not session failures. */ }
		}
	};
	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	async function obtain(ctx: ExtensionContext, kind: Kind, request: Request, refresh: boolean, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const key = keyFor(kind, request); const previous = cache.get(key); const generation = epoch;
		if (previous && !refresh) {
			try { await access(previous.fullOutputPath); await access(previous.recordPath); }
			catch { const restored = await persist(kind, request, previous.data); restored.retrievedAt = previous.retrievedAt;
				await withFileMutationQueue(restored.recordPath, () => writeFile(restored.recordPath, JSON.stringify(restored), "utf8"));
				if (generation === epoch) cache.set(key, restored);
				return { evidence: restored, apiRequests: 0, cached: true }; }
			return { evidence: previous, apiRequests: 0, cached: true };
		}
		const pending = inFlight.get(key);
		if (pending) {
			try { const { evidence } = await pending; signal?.throwIfAborted(); return { evidence, apiRequests: 0, cached: true }; }
			catch (cause) { throw Object.assign(new Error(`共享请求未完成：${cause instanceof Error ? cause.message : String(cause)}`), { apiRequests: 0 }); }
		}
		const promise = (async () => {
			const response = await callApi(ctx, kind, request, signal);
			try {
				signal?.throwIfAborted();
				const evidence = await persist(kind, request, response.data);
				if (generation === epoch) cache.set(key, evidence);
				return { evidence, apiRequests: response.apiRequests };
			} catch (cause) { throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { apiRequests: response.apiRequests }); }
		})();
		inFlight.set(key, promise);
		try { return { ...await promise, cached: false }; }
		finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
	}

	function renderCimi(e: CimiEvidence, apiRequests: number, cached: boolean, empty = false) {
		const cost = cached || empty ? 0 : CIMI_COST_YUAN[e.scope];
		const details: Details = { version: 2, query: e.query, count: e.items.length, cached, apiRequests, estimatedCostYuan: cost,
			retrievedAt: e.retrievedAt, fullOutputPath: e.fullOutputPath, recordPath: e.recordPath };
		const source = e.scope === "wechat" ? `微信搜一搜 第${e.page}页` : "库内搜索（近180天，按标题）";
		const header = `[${cached ? "缓存复用" : "新请求"}；本次API请求 ${apiRequests}；${cached ? "未计费" : `参考价 ¥${CIMI_COST_YUAN[e.scope]}/次`}，非账单]\n来源: 次幂数据 · ${source}\nQuery: ${e.query}\n取得时间: ${e.retrievedAt}`;
		if (!e.items.length) return finish(header + (empty ? "\n本次无结果（接口按未命中处理，不计费）。" : "\n本次无结果；只说明此查询未命中。"), details);
		const blocks = e.items.map((item, i) => {
			let block = `--- Result ${i + 1} ---\nTitle: ${cleanTitle(item.title)}\nLink: ${item.content_url}`;
			if (item.nickname) block += `\nAccount: ${item.nickname}`;
			if (item.published_at) block += `\nPublished: ${item.published_at}`;
			return block;
		});
		return finish(header + "\n\n" + blocks.join("\n\n"), details);
	}

	pi.registerTool({
		name: "web_search", label: "DeepSeek 搜索",
		description: "搜索网页，返回标题、链接、日期、评分和短摘要；content=true额外取内容。默认5条，预览限长，完整API响应落文件。相同请求复用缓存；变更count/content会重新请求，refresh=true强制更新。",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 128, description: "搜索词，1-128字；支持site:/lang:/after:/before:等语法" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "结果条数，默认5" })),
			content: Type.Optional(Type.Boolean({ description: "是否请求页面内容，默认false；可能只是节选，长内容从返回文件读取" })),
			oriQuestion: Type.Optional(Type.String({ description: "原始问题，帮助上游理解意图" })),
			localization: Type.Optional(Type.String({ description: "用于本地化结果的IP地址" })),
			refresh: Type.Optional(Type.Boolean({ description: "强制重新请求而非使用缓存；可能重新计费，默认false" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			try {
				const query = params.query.trim(), count = params.count ?? 5;
				if (!query || [...query].length > 128 || !Number.isInteger(count) || count < 1 || count > 50) throw new Error("query需1-128字，count需1-50整数");
				const request = { query, count, need_content: params.content ?? false, ori_question: params.oriQuestion ?? null, localization: params.localization ?? "" };
				const { evidence: e, apiRequests, cached } = await obtain(ctx, "search", request, params.refresh ?? false, signal);
				const results: SearchResult[] = e.data.results;
				const details: Details = { version: 2, query, count: results.length, cached, apiRequests,
					estimatedCostYuan: cached || !results.length ? 0 : 0.005, retrievedAt: e.retrievedAt,
					fullOutputPath: e.fullOutputPath, recordPath: e.recordPath, contentStatus: results.some(r => request.need_content && r.content) ? "has_content" : "snippet_only" };
				const header = `[${cached ? "缓存复用" : "新请求"}；本次API请求 ${apiRequests}；估算 ¥${details.estimatedCostYuan}，非账单]\nQuery: ${query}\n取得时间: ${e.retrievedAt}`;
				if (!results.length) return finish(header + "\n本次无结果；只说明此查询未命中。", details);
				const blocks = results.map((r, i) => {
					const fp = fingerprint(r, request.need_content); const seen = seenEvidence.get(r.url) === fp;
					let block = `--- Result ${i + 1}${cached || seen ? "（相同证据见完整文件）" : ""} ---\nTitle: ${r.title}\nLink: ${r.url}`;
					if (!cached && !seen) {
						block += `\nMeta: ${meta(r)}\nSnippet: ${(r.snippet ?? "").slice(0, 400)}`;
						if ((r.snippet?.length ?? 0) > 400) details.truncated = true;
						if (request.need_content && r.content) {
							const clipped = r.content.length > CONTENT_PREVIEW_CHARS;
							block += `\nContent预览（API返回内容，非全文保证）:\n${r.content.slice(0, CONTENT_PREVIEW_CHARS)}${clipped ? "\n[更多内容见文件]" : ""}`;
							details.truncated ||= clipped;
						}
					}
					seenEvidence.set(r.url, fp); return block;
				});
				return finish(header + "\n\n" + blocks.join("\n\n"), details);
			} catch (error) { return failure(error, { query: params.query }); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", args.query) + theme.fg("muted", ` · ${args.count ?? 5}条${args.content ? " · 含内容" : ""}${args.refresh ? " · 刷新" : ""}`), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "搜索中…"), 0, 0);
			const d = result.details as Details | undefined;
			if (result.isError || d?.error) return new Text(theme.fg("error", d?.error ?? "搜索失败"), 0, 0);
			return new Text(theme.fg("muted", `${d?.count ?? 0}条结果${d?.cached ? " · 缓存" : ""}${d?.truncated ? " · 预览截断" : ""}`), 0, 0);
		},
	});
	pi.registerTool({
		name: "web_fetch", label: "DeepSeek 抓取",
		description: "抓取单个 HTML 页面并提取正文，返回标题和内容预览（最多8000 UTF-8字节/300行，非8000字）。完整API返回内容写入文件供read读取；不保证目标文章完整或可访问，可读取 mp.weixin.qq.com 的公众号文章，验证页、删除页或空壳会如实提示。相同URL默认复用，refresh=true重新请求。",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL，须含host，不含用户名密码" }),
			refresh: Type.Optional(Type.Boolean({ description: "重新请求最新内容；可能重新计费，默认false" })),
			force: Type.Optional(Type.Boolean({ description: "静态文件或仓库地址默认建议用 curl/git；curl 被反爬拦住时才传 true" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			try {
				const parsed = new URL(params.url.trim());
				if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error("URL须为不含用户名密码的http(s)地址");
				if (!params.force && /\.(txt|json|ya?ml|csv|xml)$/i.test(parsed.pathname))
					throw new Error("这是静态文件，优先用 bash + curl 下载到 /tmp 再读；若 curl 取不到（反爬、鉴权），再传 force=true 用付费抓取");
				if (!params.force && /^(raw\.githubusercontent\.com|api\.github\.com|github\.com|gitlab\.com|bitbucket\.org)$/i.test(parsed.hostname))
					throw new Error("这是代码仓库/仓库接口，优先用 git clone 或 gh api；确实只能网页读取时，再传 force=true");
				const url = parsed.href;
				const { evidence: e, apiRequests, cached } = await obtain(ctx, "fetch", { url }, params.refresh ?? false, signal);
				const contentStatus = pageHint(e.data.title ?? "", e.data.content);
				const details: Details = { version: 2, url, title: e.data.title ?? "", cached, apiRequests, estimatedCostYuan: cached ? 0 : 0.005,
					retrievedAt: e.retrievedAt, fullOutputPath: e.fullOutputPath, recordPath: e.recordPath, contentStatus };
				const hint = contentStatus === "empty" ? "\n注意：接口返回的内容为空。" : contentStatus === "access_hint" ? "\n注意：疑似验证、登录或错误提示页；请求成功不代表取得文章。" : "";
				return finish(`[${cached ? "缓存复用" : "新请求"}；本次API请求 ${apiRequests}；估算 ¥${details.estimatedCostYuan}，非账单]\n取得时间: ${e.retrievedAt}${hint}\n\n` +
					(cached ? `Title: ${e.data.title || url}\nURL: ${url}\n未重复展开；读取下方文件。` : fullText("fetch", { url }, e.data)), details);
			} catch (error) { return failure(error, { url: params.url }); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url) + (args.refresh ? theme.fg("muted", " · 刷新") : ""), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "抓取中…"), 0, 0);
			const d = result.details as Details | undefined;
			if (result.isError || d?.error) return new Text(theme.fg("error", d?.error ?? "抓取失败"), 0, 0);
			const warning = d?.contentStatus === "access_hint" || d?.contentStatus === "empty";
			return new Text(theme.fg(warning ? "warning" : "muted", `${warning ? "内容需核对 · " : ""}${d?.title?.slice(0, 60) || "已取得文本"}${d?.cached ? " · 缓存" : ""}${d?.truncated ? " · 预览截断" : ""}`), 0, 0);
		},
	});
	pi.registerTool({
		name: "wechat_search", label: "次幂公众号搜索",
		description: "搜索微信公众号文章，只做发现：返回标题、链接、公众号名和发布时间，不含正文，也没有阅读、点赞、评论。scope=wechat 是微信搜一搜，参考价 ¥0.05/次，page 1-5 可翻页；scope=library 是库内搜索，参考价 ¥0.02/次，仅近180天、按标题匹配、不翻页、只给标题链接时间。未命中（1004）不计费。相同请求复用缓存；refresh=true 重新请求并重新计费。",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 200, description: "搜索词，1-200字" }),
			scope: Type.Optional(StringEnum(["wechat", "library"], { description: "wechat=搜一搜（默认）；library=库内搜索" })),
			options: Type.Optional(Type.Object({
				page: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "搜一搜页码 1-5，默认1；库内不分页" })),
				refresh: Type.Optional(Type.Boolean({ description: "强制重新请求；会重新计费" })),
			}, { description: "低频选项：翻页或刷新时才传" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			const query = params.query.trim(), scope: CimiScope = params.scope ?? "wechat", page = params.options?.page ?? 1, refresh = params.options?.refresh ?? false;
			try {
				if (!query || [...query].length > 200) throw new Error("query 需 1-200 字");
				if (scope === "library" && page !== 1) throw new Error("库内搜索不分页，page 只能为 1");
				const cacheKey = JSON.stringify([scope, query, page]);
				if (!refresh) {
					const hit = cimiCache.get(cacheKey);
					if (hit) {
						try { await access(hit.fullOutputPath); await access(hit.recordPath); }
						catch { cimiCache.delete(cacheKey); }
						if (cimiCache.get(cacheKey) === hit) return renderCimi(hit, 0, true);
					}
				}
				const config = await readCimiConfig(ctx.sessionManager.getCwd());
				const result = await cimiSearch(config, scope, query, page, signal);
				const evidence = await persistCimi(scope, query, page, result.items);
				cimiCache.set(cacheKey, evidence);
				return renderCimi(evidence, result.apiRequests, false, result.empty);
			} catch (error) { return failure(error, { query }); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("wechat_search ")) + theme.fg("accent", args.query) + theme.fg("muted", ` · ${args.scope ?? "wechat"}${args.options?.page && args.options.page > 1 ? ` 第${args.options.page}页` : ""}${args.options?.refresh ? " · 刷新" : ""}`), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "搜索中…"), 0, 0);
			const d = result.details as Details | undefined;
			if (result.isError || d?.error) return new Text(theme.fg("error", d?.error ?? "搜索失败"), 0, 0);
			return new Text(theme.fg("muted", `${d?.count ?? 0}条结果${d?.cached ? " · 缓存" : ""}${d?.truncated ? " · 预览截断" : ""}`), 0, 0);
		},
	});
	function renderSocial(e: SocialEvidence, apiRequests: number, cached: boolean) {
		const rows = socialRows(e.platform as SocialPlatform, e.data);
		const page = Number(e.request.page ?? 1);
		const details: Details = { version: 2, query: String(e.request.query ?? ""), platform: e.platform, count: rows.length, cached, apiRequests,
			chargedUsd: cached ? 0 : e.chargedUsd, retrievedAt: e.retrievedAt, fullOutputPath: e.fullOutputPath, recordPath: e.recordPath };
		const header = `[${cached ? "缓存复用" : "新请求"}；本次API请求 ${apiRequests}；${cached ? "未扣费" : `计费 $${e.chargedUsd.toFixed(4)}`}，以账单为准]\n来源: Qovia · ${e.platform === "douyin" ? "抖音" : "小红书"} 第${page}页\nQuery: ${e.request.query}\n取得时间: ${e.retrievedAt}`;
		if (!rows.length) return finish(header + "\n本次无结果（空结果不计费）。", details);
		const blocks = rows.map((row, i) => `--- Result ${i + 1} ---\nTitle: ${row.title}\nLink: ${row.url}` +
			(row.author ? `\nAuthor: ${row.author}` : "") + (row.meta ? `\n${row.meta}` : ""));
		return finish(header + "\n\n" + blocks.join("\n\n"), details);
	}
	function renderSocialFetch(e: SocialEvidence, apiRequests: number) {
		const body = socialBody(e.platform as SocialPlatform | "bilibili", e.data);
		const metrics = Object.entries(body.metrics ?? {}).filter(([, value]) => typeof value === "number").slice(0, 8).map(([name, value]) => `${name}=${value}`).join(" · ");
		const details: Details = { version: 2, url: body.url, title: body.title, platform: e.platform, apiRequests,
			chargedUsd: e.chargedUsd, retrievedAt: e.retrievedAt, fullOutputPath: e.fullOutputPath, recordPath: e.recordPath };
		const header = `[新请求；本次API请求 ${apiRequests}；计费 $${e.chargedUsd.toFixed(4)}，以账单为准]\n来源: Qovia · ${e.platform}\n取得时间: ${e.retrievedAt}`;
		const lines = [`# ${body.title || body.url}`, `URL: ${body.url}`, body.author ? `Author: ${body.author}` : "",
			body.published ? `Published: ${body.published}` : "", metrics, "", body.text].filter(Boolean);
		return finish(header + "\n\n" + lines.join("\n"), details);
	}

	pi.registerTool({
		name: "social_search", label: "社媒搜索",
		description: "搜索抖音或小红书作品，返回标题、作者、互动数和链接。抖音每次 $0.0005，小红书 $0.005；空结果和失败不扣。page 默认 1（1-50）；抖音翻页依赖同会话上一页。",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 50, description: "搜索词，1-50字" }),
			platform: StringEnum(["xiaohongshu", "douyin"], { description: "xiaohongshu=小红书；douyin=抖音" }),
			options: Type.Optional(Type.Object({
				page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "页码，默认1；抖音要按顺序翻" })),
				sort: Type.Optional(StringEnum(["general", "latest", "most_liked", "most_commented", "most_saved"], { description: "排序，仅小红书生效；默认 general" })),
			}, { description: "低频选项：翻页或排序时才传" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			const query = params.query.trim(), platform = params.platform, page = params.options?.page ?? 1, sort = params.options?.sort;
			try {
				if (!query || [...query].length > 50) throw new Error("query 需 1-50 字");
				if (sort && platform === "douyin") throw new Error("sort 只支持小红书；抖音用默认排序");
				const cacheKey = `${platform}|${query}|${page}`, hit = socialCache.get(cacheKey);
				if (hit) {
					try { await access(hit.fullOutputPath); await access(hit.recordPath); }
					catch { socialCache.delete(cacheKey); }
					if (socialCache.get(cacheKey) === hit) return renderSocial(hit, 0, true);
				}
				const { key } = await readQoviaKey(ctx.sessionManager.getCwd());
				const { data, chargedUsd } = await socialSearch(key, platform, query, page, sort, signal);
				const evidence = await persistSocial({ key: cacheKey, kind: "search", platform, request: { query, page }, data, chargedUsd });
				socialCache.set(cacheKey, evidence);
				return renderSocial(evidence, 1, false);
			} catch (error) { return failure(error, { query }); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("social_search ")) + theme.fg("accent", args.query) + theme.fg("muted", ` · ${args.platform === "douyin" ? "抖音" : "小红书"}${args.options?.page && args.options.page > 1 ? ` 第${args.options.page}页` : ""}`), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "搜索中…"), 0, 0);
			const d = result.details as Details | undefined;
			if (result.isError || d?.error) return new Text(theme.fg("error", d?.error ?? "搜索失败"), 0, 0);
			return new Text(theme.fg("muted", `${d?.count ?? 0}条结果${d?.cached ? " · 缓存" : ""}${d?.truncated ? " · 预览截断" : ""}`), 0, 0);
		},
	});
	pi.registerTool({
		name: "social_fetch", label: "社媒抓取",
		description: "按作品 URL 读抖音、小红书或 B 站的内容：标题、正文或简介、作者、互动数。抖音和 B 站每次 $0.0005，小红书 $0.005；空结果和失败不扣。只认标准作品链接，短链要先展开。",
		parameters: Type.Object({
			url: Type.String({ maxLength: 2048, description: "作品链接：bilibili.com/video/BV…、douyin.com/video/<数字>、xiaohongshu.com/explore/<24位>" }),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			const url = params.url.trim();
			try {
				const target = parseSocialUrl(url);
				const { key } = await readQoviaKey(ctx.sessionManager.getCwd());
				const path = target.platform === "bilibili" ? "/v1/raw/bilibili/video" : target.platform === "douyin" ? "/v1/raw/douyin/video" : "/v1/raw/xiaohongshu/note";
				const name = target.platform === "bilibili" ? "bvid" : target.platform === "douyin" ? "item_id" : "note_id";
				const { data, chargedUsd } = await qoviaGet(key, path, { [name]: target.id }, signal);
				const evidence = await persistSocial({ key: `url|${url}`, kind: "fetch", platform: target.platform, request: { url }, data, chargedUsd });
				return renderSocialFetch(evidence, 1);
			} catch (error) { return failure(error, { url }); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("social_fetch ")) + theme.fg("accent", args.url), 0, 0); },
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "读取中…"), 0, 0);
			const d = result.details as Details | undefined;
			if (result.isError || d?.error) return new Text(theme.fg("error", d?.error ?? "读取失败"), 0, 0);
			return new Text(theme.fg("muted", `${d?.title?.slice(0, 60) || "已取得内容"}${d?.truncated ? " · 预览截断" : ""}`), 0, 0);
		},
	});
}
