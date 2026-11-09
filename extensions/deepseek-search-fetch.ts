import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const PROVIDER = "deepseek";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_500;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PREVIEW_BYTES = 8_000;
const CONTENT_PREVIEW_CHARS = 600;
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
	apiRequests: number; estimatedCostYuan?: number; retrievedAt?: string; truncated?: boolean;
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
function failure(error: unknown, input: { query?: string; url?: string }) {
	const message = error instanceof Error ? error.message : String(error);
	const apiRequests = (error as any)?.apiRequests ?? 0;
	return { isError: true, content: [{ type: "text" as const, text: `${message}\n本次API请求: ${apiRequests}；费用未核实。` }], details: { ...input, error: message, apiRequests } as Details };
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, Evidence>();
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
		description: "抓取单个网页，返回标题和内容预览（最多8000 UTF-8字节/300行，非8000字）。完整API返回内容写入文件供read读取；不保证目标文章完整或可访问。相同URL默认复用，refresh=true重新请求。",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL，须含host，不含用户名密码" }),
			refresh: Type.Optional(Type.Boolean({ description: "重新请求最新内容；可能重新计费，默认false" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _update, ctx) {
			try {
				const parsed = new URL(params.url.trim());
				if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error("URL须为不含用户名密码的http(s)地址");
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
}
