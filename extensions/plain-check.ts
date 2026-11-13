import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type CompiledRegex = {
	pattern: string;
	regex: RegExp;
};

export type Config = {
	enabled: boolean;
	max_retries: number;
	regex_min_sentences: number;
	keywords: string[];
	regex: string[];
	tail_regex?: string[];
};

export type Hit = {
	kind: "keyword" | "regex" | "tail_regex";
	rule: string;
	match: string;
	count: number;
};

const MODULE_DIR =
	typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_CANON_CONFIG_PATH = path.resolve(MODULE_DIR, "..", "canon", "plain-check.toml");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const LOCAL_CONFIG_PATH = path.join(AGENT_DIR, "plain-check.toml");
const LOG_PATH = path.join(AGENT_DIR, "plain-check.log.jsonl");
const MARKER_RETRY = "<!-- plain-check:retry -->\n";
const MARKER_STOP = "<!-- plain-check:stop -->\n";
const REWRITE_TYPE = "plain-check-rewrite";

const DEFAULT_CONFIG: Config = {
	enabled: false,
	max_retries: 3,
	regex_min_sentences: 2,
	keywords: [],
	regex: [],
	tail_regex: [],
};

function unescapeTomlBasicString(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i]!;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		i += 1;
		const esc = body[i];
		if (esc === undefined) break;
		switch (esc) {
			case "b":
				out += "\b";
				break;
			case "t":
				out += "\t";
				break;
			case "n":
				out += "\n";
				break;
			case "f":
				out += "\f";
				break;
			case "r":
				out += "\r";
				break;
			case '"':
				out += '"';
				break;
			case "\\":
				out += "\\";
				break;
			case "u": {
				const hex = body.slice(i + 1, i + 5);
				if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
					out += String.fromCodePoint(parseInt(hex, 16));
					i += 4;
				} else {
					out += "\\u";
				}
				break;
			}
			case "U": {
				const hex = body.slice(i + 1, i + 9);
				if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
					out += String.fromCodePoint(parseInt(hex, 16));
					i += 8;
				} else {
					out += "\\U";
				}
				break;
			}
			default:
				out += esc;
				break;
		}
	}
	return out;
}

export function parsePlainCheckToml(source: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const len = source.length;
	let pos = 0;

	const skipWsAndComments = () => {
		while (pos < len) {
			const ch = source[pos]!;
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
				pos += 1;
				continue;
			}
			if (ch === "#") {
				while (pos < len && source[pos] !== "\n") pos += 1;
				continue;
			}
			break;
		}
	};

	const readString = (): string => {
		const quote = source[pos]!;
		pos += 1;
		if (quote === "'") {
			const start = pos;
			while (pos < len && source[pos] !== "'" && source[pos] !== "\n") pos += 1;
			if (source[pos] !== "'") throw new Error("Unterminated literal string in plain-check.toml");
			const val = source.slice(start, pos);
			pos += 1;
			return val;
		}
		let body = "";
		while (pos < len) {
			const ch = source[pos]!;
			if (ch === '"') {
				pos += 1;
				return unescapeTomlBasicString(body);
			}
			if (ch === "\\") {
				body += source.slice(pos, pos + 2);
				pos += 2;
				continue;
			}
			if (ch === "\n") throw new Error("Unterminated basic string in plain-check.toml");
			body += ch;
			pos += 1;
		}
		throw new Error("Unterminated basic string in plain-check.toml");
	};

	const readArray = (): string[] => {
		pos += 1; // skip '['
		const items: string[] = [];
		while (true) {
			skipWsAndComments();
			if (pos >= len) throw new Error("Unterminated array in plain-check.toml");
			if (source[pos] === "]") {
				pos += 1;
				return items;
			}
			const ch = source[pos]!;
			if (ch !== '"' && ch !== "'") {
				throw new Error(`Expected string element in array near offset ${pos}`);
			}
			items.push(readString());
			skipWsAndComments();
			if (source[pos] === ",") {
				pos += 1;
				continue;
			}
			if (source[pos] === "]") {
				pos += 1;
				return items;
			}
			throw new Error(`Expected ',' or ']' in array near offset ${pos}`);
		}
	};

	while (pos < len) {
		skipWsAndComments();
		if (pos >= len) break;
		if (source[pos] === "[") {
			// Skip table header line if ever present
			while (pos < len && source[pos] !== "\n") pos += 1;
			continue;
		}
		const keyStart = pos;
		while (pos < len && /[A-Za-z0-9_-]/.test(source[pos]!)) pos += 1;
		const key = source.slice(keyStart, pos);
		if (!key) throw new Error(`Unexpected character '${source[pos]}' at offset ${pos}`);
		while (pos < len && (source[pos] === " " || source[pos] === "\t")) pos += 1;
		if (source[pos] !== "=") throw new Error(`Expected '=' after key '${key}'`);
		pos += 1;
		while (pos < len && (source[pos] === " " || source[pos] === "\t")) pos += 1;

		const valChar = source[pos];
		if (valChar === "[") {
			result[key] = readArray();
		} else if (valChar === '"' || valChar === "'") {
			result[key] = readString();
		} else {
			const scalarStart = pos;
			while (pos < len && !/[ \t\r\n#]/.test(source[pos]!)) pos += 1;
			const rawScalar = source.slice(scalarStart, pos);
			if (rawScalar === "true") result[key] = true;
			else if (rawScalar === "false") result[key] = false;
			else if (/^[+-]?\d+(?:\.\d+)?$/.test(rawScalar)) result[key] = Number(rawScalar);
			else result[key] = rawScalar;
		}
	}

	return result;
}

export function resolveConfigPath(): string {
	if (fs.existsSync(LOCAL_CONFIG_PATH)) return LOCAL_CONFIG_PATH;
	if (fs.existsSync(PACKAGE_CANON_CONFIG_PATH)) return PACKAGE_CANON_CONFIG_PATH;
	return LOCAL_CONFIG_PATH;
}

export function loadConfig(explicitPath?: string): { config: Config; configPath: string } {
	const configPath = explicitPath ?? resolveConfigPath();
	if (!fs.existsSync(configPath)) {
		return { config: { ...DEFAULT_CONFIG, enabled: false }, configPath };
	}
	const raw = fs.readFileSync(configPath, "utf8");
	const data = parsePlainCheckToml(raw);
	const keywords = Array.isArray(data.keywords)
		? data.keywords.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
		: [];
	const regex = Array.isArray(data.regex)
		? data.regex.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
		: [];
	const tailRegex = Array.isArray(data.tail_regex)
		? data.tail_regex.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
		: [];
	const retries = Number(data.max_retries);
	const minSentences = Number(data.regex_min_sentences);
	return {
		configPath,
		config: {
			enabled: data.enabled !== false,
			max_retries: Number.isFinite(retries) && retries >= 0 ? Math.floor(retries) : 3,
			regex_min_sentences:
				Number.isFinite(minSentences) && minSentences >= 1 ? Math.floor(minSentences) : 2,
			keywords,
			regex,
			tail_regex: tailRegex,
		},
	};
}

export type PreparedKeyword = {
	rule: string;
	needle: string;
};

export type CompiledRules = {
	keywords: PreparedKeyword[];
	hasAsciiKeyword: boolean;
	keywordFastRegex: RegExp | null;
	regexes: CompiledRegex[];
	tailRegexes: CompiledRegex[];
	errors: string[];
};

const RE_ASCII_LETTER = /[A-Za-z]/;
const RE_REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const RE_NON_NEWLINE = /[^\n]/g;
const RE_FENCE_BACKTICK = /```[\s\S]*?```/g;
const RE_FENCE_TILDE = /~~~[\s\S]*?~~~/g;
const RE_INLINE_CODE = /`[^`\n]*`/g;
const RE_FILE_LINK = /\[[^\]]*\]\(file:\/\/[^\s)]+\)/g;
const RE_HTTP_URL = /https?:\/\/\S+/g;
const RE_WIN_PATH = /[A-Za-z]:\\[^\s]+/g;
const RE_MD_TABLE_ROW = /^\|.*\|$/gm;
const RE_BLOCKQUOTE_LINE = /^\s*>.*$/gm;
const RE_SENTENCE_SPLIT = /\n\s*\n|[。！？!?]+|\.(?=\s|$)/;
const RE_SENTENCE_WITH_PUNCT = /[^。！？!?\n]+(?:[。！？!?]+|$)/g;
const MARKER_PREFIX = "<!-- plain-check:";
const MAX_NOTICE_CACHE = 64;

export function compileRegexes(patterns: string[]): { regexes: CompiledRegex[]; errors: string[] } {
	const regexes: CompiledRegex[] = [];
	const errors: string[] = [];
	for (const pattern of patterns) {
		try {
			regexes.push({ pattern, regex: new RegExp(pattern, "i") });
		} catch (error) {
			errors.push(`${pattern}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { regexes, errors };
}

export function compileRules(config: Config, precompiledRegexes?: CompiledRegex[]): CompiledRules {
	const keywords: PreparedKeyword[] = [];
	let hasAsciiKeyword = false;
	const escapedParts: string[] = [];

	for (const keyword of config.keywords) {
		if (!keyword) continue;
		const hasAscii = RE_ASCII_LETTER.test(keyword);
		if (hasAscii) hasAsciiKeyword = true;
		const needle = hasAscii ? keyword.toLowerCase() : keyword;
		keywords.push({ rule: keyword, needle });
		escapedParts.push(needle.replace(RE_REGEX_ESCAPE, "\\$&"));
	}

	const keywordFastRegex =
		escapedParts.length > 0 ? new RegExp(escapedParts.join("|"), hasAsciiKeyword ? "i" : "") : null;

	const compiledTail = compileRegexes(config.tail_regex ?? []);
	if (precompiledRegexes) {
		return {
			keywords,
			hasAsciiKeyword,
			keywordFastRegex,
			regexes: precompiledRegexes,
			tailRegexes: compiledTail.regexes,
			errors: compiledTail.errors,
		};
	}
	const compiled = compileRegexes(config.regex);
	return {
		keywords,
		hasAsciiKeyword,
		keywordFastRegex,
		regexes: compiled.regexes,
		tailRegexes: compiledTail.regexes,
		errors: [...compiled.errors, ...compiledTail.errors],
	};
}

function blank(value: string): string {
	if (!value.includes("\n")) return " ".repeat(value.length);
	return value.replace(RE_NON_NEWLINE, " ");
}

export function maskText(text: string): string {
	let out = text;
	if (out.includes("```")) out = out.replace(RE_FENCE_BACKTICK, blank);
	if (out.includes("~~~")) out = out.replace(RE_FENCE_TILDE, blank);
	if (out.includes("`")) out = out.replace(RE_INLINE_CODE, blank);
	if (out.includes("](file://")) out = out.replace(RE_FILE_LINK, blank);
	if (out.includes("http://") || out.includes("https://")) out = out.replace(RE_HTTP_URL, blank);
	if (out.includes(":\\")) out = out.replace(RE_WIN_PATH, blank);
	if (out.includes("|")) out = out.replace(RE_MD_TABLE_ROW, blank);
	return out;
}

export function splitSentences(text: string): string[] {
	const rawParts = text.split(RE_SENTENCE_SPLIT);
	const out: string[] = [];
	for (let i = 0; i < rawParts.length; i += 1) {
		const trimmed = rawParts[i]!.trim();
		if (trimmed.length > 0) out.push(trimmed);
	}
	return out;
}

export function extractTailSegment(maskedText: string): string {
	const withoutQuotes = maskedText.includes(">") ? maskedText.replace(RE_BLOCKQUOTE_LINE, "") : maskedText;
	const paragraphs = withoutQuotes
		.split(/\n\s*\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (paragraphs.length === 0) return "";
	const lastParagraph = paragraphs[paragraphs.length - 1]!;
	const chunks = (lastParagraph.match(RE_SENTENCE_WITH_PUNCT) ?? [])
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (chunks.length <= 2) return lastParagraph;
	return chunks.slice(-2).join(" ");
}

function isCompiledRules(arg: CompiledRegex[] | CompiledRules | undefined): arg is CompiledRules {
	return Boolean(arg && !Array.isArray(arg) && "regexes" in arg);
}

export function auditText(
	text: string,
	config: Config,
	rulesOrRegexes?: CompiledRegex[] | CompiledRules,
): Hit[] {
	const rules = isCompiledRules(rulesOrRegexes)
		? rulesOrRegexes
		: compileRules(config, rulesOrRegexes);
	const masked = maskText(text);
	const hits: Hit[] = [];

	if (rules.keywords.length > 0 && (!rules.keywordFastRegex || rules.keywordFastRegex.test(masked))) {
		const haystack = rules.hasAsciiKeyword ? masked.toLowerCase() : masked;
		for (let k = 0; k < rules.keywords.length; k += 1) {
			const { rule, needle } = rules.keywords[k]!;
			let count = 0;
			let first = "";
			let from = 0;
			while (true) {
				const index = haystack.indexOf(needle, from);
				if (index === -1) break;
				if (!first) first = masked.slice(index, index + needle.length);
				count += 1;
				from = index + needle.length;
			}
			if (count > 0) hits.push({ kind: "keyword", rule, match: first || rule, count });
		}
	}

	if (rules.regexes.length > 0) {
		const minSentences = config.regex_min_sentences;
		const sentences = splitSentences(masked);
		const sentenceCount = sentences.length;
		if (sentenceCount >= minSentences) {
			for (let r = 0; r < rules.regexes.length; r += 1) {
				const compiled = rules.regexes[r]!;
				let count = 0;
				let first = "";
				for (let s = 0; s < sentenceCount; s += 1) {
					if (count + (sentenceCount - s) < minSentences) break;
					const sentence = sentences[s]!;
					if (!first) {
						const matched = compiled.regex.exec(sentence);
						if (!matched) continue;
						first = matched[0] ?? sentence;
						count += 1;
					} else if (compiled.regex.test(sentence)) {
						count += 1;
					}
				}
				if (count >= minSentences) {
					hits.push({
						kind: "regex",
						rule: compiled.pattern,
						match: first || compiled.pattern,
						count,
					});
				}
			}
		}
	}

	if (rules.tailRegexes.length > 0) {
		const tail = extractTailSegment(masked);
		if (tail) {
			for (let t = 0; t < rules.tailRegexes.length; t += 1) {
				const compiled = rules.tailRegexes[t]!;
				const matched = compiled.regex.exec(tail);
				if (matched) {
					hits.push({
						kind: "tail_regex",
						rule: compiled.pattern,
						match: matched[0] ?? tail,
						count: 1,
					});
				}
			}
		}
	}

	return hits;
}

export function stripMarkers(text: string): string {
	if (!text.includes(MARKER_PREFIX)) return text;
	return text.replaceAll(MARKER_RETRY, "").replaceAll(MARKER_STOP, "");
}

export function renderNotice(hits: Hit[], stopped: boolean): string {
	const labels = hits.map((hit) => {
		const text = (hit.match || hit.rule).replace(/\s+/g, " ").trim();
		const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text;
		const count = hit.count > 1 ? ` ×${hit.count}${hit.kind === "regex" ? " 句" : ""}` : "";
		return `${clipped}${count}`;
	});
	const shown = labels.slice(0, 6);
	const more = labels.length > shown.length ? ` 等 ${labels.length} 处` : "";
	const lines = [
		stopped ? "> ⚠️ 重写后仍不合规，已回滚并停止" : "> ⚠️ 输出不合规，已回滚",
		`> 命中：${shown.length ? shown.join("、") + more : "黑名单规则"}`,
	];
	if (!stopped) lines.push("> 正在重新生成…");
	return lines.join("\n");
}

export function buildFeedback(hits: Hit[], originalDraft?: string): string {
	const rules = hits.map((hit) => {
		const matched = (hit.match || hit.rule).replace(/\s+/g, " ").trim();
		const clipped = matched.length > 80 ? `${matched.slice(0, 77)}...` : matched;
		const count = hit.count > 1 ? `，${hit.count} ${hit.kind === "regex" ? "句" : "次"}` : "";
		if (hit.kind === "tail_regex") {
			return `末尾追问/客套规则 ${hit.rule}（匹配：${clipped}）`;
		}
		return hit.kind === "regex"
			? `${hit.rule}（匹配：${clipped}${count}）`
			: `${hit.rule}${count}`;
	});
	const uniqueRules = [...new Set(rules)];
	const hasTailHit = hits.some((h) => h.kind === "tail_regex");
	const instruction = hasTailHit
		? "请重写你上一条回复。保留事实、代码、命令和结论；直接删除末尾未授权的追问、菜单式选择题或客套话；不要解释，不要提审查；只输出改写后的回复。"
		: "请重写你上一条回复。保留事实、代码、命令和结论；不要解释，不要提审查；只输出改写后的回复。";
	const lines = [
		"你上一条回复被回滚了，因为命中了黑名单：",
		...uniqueRules.map((rule) => `- ${rule}`),
		"",
		instruction,
	];
	if (originalDraft && originalDraft.trim().length > 0) {
		lines.push("", "<previous_draft>", originalDraft, "</previous_draft>");
	}
	return lines.join("\n");
}

function isFinalAssistant(message: any): boolean {
	if (message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) {
		return false;
	}
	let hasText = false;
	for (const block of message.content) {
		if (block?.type === "toolCall") return false;
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			hasText = true;
		}
	}
	return hasText;
}

function textOf(message: any): string {
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return "";
	if (content.length === 1) {
		const block = content[0];
		return block?.type === "text" && typeof block.text === "string" ? block.text : "";
	}
	const parts: string[] = [];
	for (let i = 0; i < content.length; i += 1) {
		const block = content[i];
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function markMessage(message: any, marker: string): any {
	return {
		...message,
		content: (message.content ?? []).map((block: any) =>
			block?.type === "text" && typeof block.text === "string" && block.text.length > 0
				? { ...block, text: marker + block.text }
				: block,
		),
	};
}

export function rollbackMessage(
	message: any,
	marker: string,
	hits: Hit[],
	stopped: boolean,
	tui: boolean,
): any {
	if (tui) return markMessage(message, marker);
	return { ...message, content: [{ type: "text", text: marker + renderNotice(hits, stopped) }] };
}

function logAudit(message: any, hits: Hit[], action: "retry" | "stopped"): void {
	const line = `${JSON.stringify({
		ts: new Date().toISOString(),
		provider: message.provider,
		model: message.model,
		action,
		hits: hits.map((hit) => ({ kind: hit.kind, rule: hit.rule, match: hit.match, count: hit.count })),
	})}\n`;
	void fs.promises.appendFile(LOG_PATH, line, "utf8").catch(() => {
		// Logging must not break the reply.
	});
}

function setStatus(ctx: any, text: string): void {
	if (ctx?.hasUI) ctx.ui.setStatus("plain-check", text);
}

function cacheNotice(cache: Map<string, string>, key: string, value: string): void {
	if (cache.size >= MAX_NOTICE_CACHE && !cache.has(key)) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

export default function plainCheck(pi: ExtensionAPI): void {
	let config: Config = { ...DEFAULT_CONFIG };
	let activeConfigPath = LOCAL_CONFIG_PATH;
	let rules: CompiledRules = compileRules(DEFAULT_CONFIG);
	const noticeCache = new Map<string, string>();
	let attempts = 0;
	let pendingRewrite = false;

	const applyConfig = () => {
		const loaded = loadConfig();
		config = loaded.config;
		activeConfigPath = loaded.configPath;
		rules = compileRules(loaded.config);
		noticeCache.clear();
		attempts = 0;
		pendingRewrite = false;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			applyConfig();
			if (ctx.hasUI && rules.errors.length > 0) {
				ctx.ui.notify(`plain-check: ${rules.errors.length} 条 regex 无效，已跳过`, "warning");
			}
			if (ctx.hasUI) {
				const count = rules.keywords.length + rules.regexes.length + rules.tailRegexes.length;
				ctx.ui.setStatus("plain-check", config.enabled ? `plain-check: ${count} 条` : "plain-check: off");
			}
		} catch (error) {
			config = { ...DEFAULT_CONFIG, enabled: false };
			rules = compileRules(config);
			noticeCache.clear();
			if (ctx.hasUI) {
				ctx.ui.notify(`plain-check: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});

	pi.on("input", (event) => {
		if ((event as any).source !== "extension") {
			attempts = 0;
			pendingRewrite = false;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!config.enabled) return;
		const message = event.message as any;
		if (!isFinalAssistant(message)) return;
		const draft = textOf(message);
		if (!draft.trim()) return;
		const hits = auditText(draft, config, rules);
		if (hits.length === 0) {
			pendingRewrite = false;
			setStatus(ctx, "plain-check: ok");
			return;
		}

		const tui = (ctx as any).mode === "tui";
		const canRetry = attempts < config.max_retries;
		if (!canRetry) {
			logAudit(message, hits, "stopped");
			pendingRewrite = false;
			setStatus(ctx, `plain-check: ${hits.length} 处，已停止`);
			const rolled = rollbackMessage(message, MARKER_STOP, hits, true, tui);
			if (tui) {
				cacheNotice(noticeCache, textOf(rolled), renderNotice(hits, true));
			}
			return { message: rolled };
		}

		attempts += 1;
		logAudit(message, hits, "retry");
		setStatus(ctx, `plain-check: ${hits.length} 处，重写中`);
		try {
			pi.sendMessage(
				{
					customType: REWRITE_TYPE,
					content: buildFeedback(hits, tui ? undefined : draft),
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			pendingRewrite = true;
		} catch {
			pendingRewrite = false;
			const rolled = rollbackMessage(message, MARKER_STOP, hits, true, tui);
			if (tui) {
				cacheNotice(noticeCache, textOf(rolled), renderNotice(hits, true));
			}
			return { message: rolled };
		}
		const rolled = rollbackMessage(message, MARKER_RETRY, hits, false, tui);
		if (tui) {
			cacheNotice(noticeCache, textOf(rolled), renderNotice(hits, false));
		}
		return { message: rolled };
	});

	(pi as any).registerMarkdownTransformer((markdown: string, context: any) => {
		if (context?.messageType !== "assistant" || !markdown.startsWith(MARKER_PREFIX)) return markdown;
		const marker = markdown.startsWith(MARKER_STOP)
			? MARKER_STOP
			: markdown.startsWith(MARKER_RETRY)
				? MARKER_RETRY
				: null;
		if (!marker) return markdown;
		const cached = noticeCache.get(markdown);
		if (cached !== undefined) return cached;
		const text = stripMarkers(markdown);
		const rendered = renderNotice(auditText(text, config, rules), marker === MARKER_STOP);
		cacheNotice(noticeCache, markdown, rendered);
		return rendered;
	});

	pi.on("context", async (event) => {
		const rawMessages = event.messages as any[];
		let latestRewrite = -1;
		let rewriteCount = 0;
		let hasMarkedAssistant = false;

		for (let i = 0; i < rawMessages.length; i += 1) {
			const msg = rawMessages[i];
			if (msg?.role === "custom" && msg.customType === REWRITE_TYPE) {
				latestRewrite = i;
				rewriteCount += 1;
				continue;
			}
			if (!hasMarkedAssistant && msg?.role === "assistant" && Array.isArray(msg.content)) {
				for (let j = 0; j < msg.content.length; j += 1) {
					const block = msg.content[j];
					if (block?.type === "text" && typeof block.text === "string" && block.text.includes(MARKER_PREFIX)) {
						hasMarkedAssistant = true;
						break;
					}
				}
			}
		}

		if (rewriteCount === 0 && !hasMarkedAssistant) {
			return undefined;
		}

		const out: any[] = [];
		for (let i = 0; i < rawMessages.length; i += 1) {
			const msg = rawMessages[i];
			if (msg?.role === "custom" && msg.customType === REWRITE_TYPE) {
				if (pendingRewrite && i === latestRewrite) out.push(msg);
				continue;
			}
			if (hasMarkedAssistant && msg?.role === "assistant" && Array.isArray(msg.content)) {
				let blockChanged = false;
				const nextContent = msg.content.map((block: any) => {
					if (block?.type === "text" && typeof block.text === "string" && block.text.includes(MARKER_PREFIX)) {
						blockChanged = true;
						return { ...block, text: stripMarkers(block.text) };
					}
					return block;
				});
				out.push(blockChanged ? { ...msg, content: nextContent } : msg);
			} else {
				out.push(msg);
			}
		}
		return { messages: out };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingRewrite) {
			pendingRewrite = false;
			setStatus(ctx, "plain-check: 重写未完成");
		}
	});

	pi.registerCommand("plain", {
		description: "Inspect or reload the plain-check blacklist",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const action = args.split(/\s+/)[0] ?? "status";
			const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};

			try {
				if (action === "test") {
					const text = args.replace(/^test\s*/i, "");
					if (!text) {
						notify("用法：/plain test <文本>", "warning");
						return;
					}
					const hits = auditText(text, config, rules);
					notify(
						hits.length === 0 ? "无命中" : renderNotice(hits, false),
						hits.length === 0 ? "info" : "warning",
					);
					return;
				}

				if (action === "check") {
					const branch = (ctx.sessionManager as any)?.getBranch?.() ?? [];
					let text = "";
					for (let index = branch.length - 1; index >= 0; index -= 1) {
						const entry: any = branch[index];
						const message = entry?.type === "message" ? entry.message : undefined;
						if (
							message?.role === "assistant" &&
							message.stopReason === "stop" &&
							Array.isArray(message.content)
						) {
							const candidate = stripMarkers(textOf(message));
							if (candidate.trim()) {
								text = candidate;
								break;
							}
						}
					}
					if (!text) {
						notify("找不到已完成的助手回复", "warning");
						return;
					}
					const hits = auditText(text, config, rules);
					notify(
						hits.length === 0 ? "无命中" : renderNotice(hits, false),
						hits.length === 0 ? "info" : "warning",
					);
					return;
				}

				if (action === "reload") {
					applyConfig();
					notify(
						`已重载：${rules.keywords.length} keyword，${rules.regexes.length} regex，${rules.tailRegexes.length} tail_regex，max_retries=${config.max_retries}`,
						"info",
					);
					if (rules.errors.length > 0) {
						notify(`有 ${rules.errors.length} 条 regex 无效`, "warning");
					}
					return;
				}

				if (action === "on" || action === "off") {
					config = { ...config, enabled: action === "on" };
					notify(`plain-check ${config.enabled ? "on" : "off"}`, "info");
					return;
				}

				notify(
					`plain-check ${config.enabled ? "on" : "off"}；${rules.keywords.length} keyword，${rules.regexes.length} regex，${rules.tailRegexes.length} tail_regex；max_retries=${config.max_retries}；配置：${activeConfigPath}`,
					"info",
				);
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
