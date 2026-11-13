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
	negation_max_retries?: number;
	regex_min_sentences: number;
	negation_sentence_ratio?: number;
	negation_max_per_sentence?: number;
	keywords: string[];
	regex: string[];
	tail_regex?: string[];
	negation_regex?: string[];
	negation_allow?: string[];
};

export type Hit = {
	kind: "keyword" | "regex" | "tail_regex" | "negation";
	rule: string;
	match: string;
	count: number;
	budget?: number;
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
	negation_max_retries: 1,
	regex_min_sentences: 2,
	negation_sentence_ratio: 3,
	negation_max_per_sentence: 2,
	keywords: [],
	regex: [],
	tail_regex: [],
	negation_regex: [],
	negation_allow: [],
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
	const asStringList = (val: unknown): string[] =>
		Array.isArray(val)
			? val.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
			: [];
	const keywords = asStringList(data.keywords);
	const regex = asStringList(data.regex);
	const tailRegex = asStringList(data.tail_regex);
	const negationRegex = asStringList(data.negation_regex);
	const negationAllow = asStringList(data.negation_allow);
	const retries = Number(data.max_retries);
	const negRetries = Number(data.negation_max_retries);
	const minSentences = Number(data.regex_min_sentences);
	const negRatio = Number(data.negation_sentence_ratio);
	const negMaxPerSentence = Number(data.negation_max_per_sentence);
	return {
		configPath,
		config: {
			enabled: data.enabled !== false,
			max_retries: Number.isFinite(retries) && retries >= 0 ? Math.floor(retries) : 3,
			negation_max_retries: Number.isFinite(negRetries) && negRetries >= 0 ? Math.floor(negRetries) : 1,
			regex_min_sentences:
				Number.isFinite(minSentences) && minSentences >= 1 ? Math.floor(minSentences) : 2,
			negation_sentence_ratio:
				Number.isFinite(negRatio) && negRatio >= 1 ? Math.floor(negRatio) : 3,
			negation_max_per_sentence:
				Number.isFinite(negMaxPerSentence) && negMaxPerSentence >= 1 ? Math.floor(negMaxPerSentence) : 2,
			keywords,
			regex,
			tail_regex: tailRegex,
			negation_regex: negationRegex,
			negation_allow: negationAllow,
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
	negationRegexes: CompiledRegex[];
	negationAllowRegex: RegExp | null;
	errors: string[];
};

export type TypedSentence = {
	text: string;
	isHeading: boolean;
};

const RE_ASCII_LETTER = /[A-Za-z]/;
const RE_REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const RE_NON_NEWLINE = /[^\n]/g;
const RE_FENCE_BACKTICK = /```[\s\S]*?```/g;
const RE_FENCE_TILDE = /~~~[\s\S]*?~~~/g;
const RE_INLINE_CODE = /`[^`\n]*`/g;
const RE_LOCAL_URI_LINK = /\[[^\]]*\]\((?:file|vscode):\/\/[^\s)]+\)/g;
const RE_HTTP_URL = /https?:\/\/\S+/g;
const RE_WIN_PATH = /[A-Za-z]:\\[^\s]+/g;
const RE_MD_TABLE_ROW = /^\|.*\|$/gm;
const RE_BLOCKQUOTE_LINE = /^\s*>.*$/gm;
const RE_HORIZONTAL_RULE = /^(?:---+|\*\*\*+|___+)$/;
const RE_HEADING_LINE = /^#{1,6}\s+(.*)$/;
const RE_LIST_PREFIX = /^(?:[-*+]|\d+[.)])\s+/;
const RE_INTRA_LINE_SENTENCE_SPLIT = /[。！？!?]+|(?<!^(?:\d+\.)*\d+)\.(?=\s|$)/;
const RE_SENTENCE_WITH_PUNCT = /[^。！？!?\n]+(?:[。！？!?]+|$)/g;
const RE_LEADING_NEG_DELIM = /^[，,；;：:、\s]+/;
const MARKER_PREFIX = "<!-- plain-check:";
const MAX_NOTICE_CACHE = 64;

export function compileRegexes(
	patterns: string[],
	flags = "i",
): { regexes: CompiledRegex[]; errors: string[] } {
	const regexes: CompiledRegex[] = [];
	const errors: string[] = [];
	for (const pattern of patterns) {
		try {
			regexes.push({ pattern, regex: new RegExp(pattern, flags) });
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

	const allowItems = [...(config.negation_allow ?? [])]
		.filter((w) => w.length > 0)
		.sort((a, b) => b.length - a.length);
	const hasAsciiAllow = allowItems.some((w) => RE_ASCII_LETTER.test(w));
	const negationAllowRegex =
		allowItems.length > 0
			? new RegExp(
					allowItems.map((w) => w.replace(RE_REGEX_ESCAPE, "\\$&")).join("|"),
					hasAsciiAllow ? "gi" : "g",
				)
			: null;

	const compiledTail = compileRegexes(config.tail_regex ?? []);
	const compiledNegation = compileRegexes(config.negation_regex ?? [], "gi");
	if (precompiledRegexes) {
		return {
			keywords,
			hasAsciiKeyword,
			keywordFastRegex,
			regexes: precompiledRegexes,
			tailRegexes: compiledTail.regexes,
			negationRegexes: compiledNegation.regexes,
			negationAllowRegex,
			errors: [...compiledTail.errors, ...compiledNegation.errors],
		};
	}
	const compiled = compileRegexes(config.regex);
	return {
		keywords,
		hasAsciiKeyword,
		keywordFastRegex,
		regexes: compiled.regexes,
		tailRegexes: compiledTail.regexes,
		negationRegexes: compiledNegation.regexes,
		negationAllowRegex,
		errors: [...compiled.errors, ...compiledTail.errors, ...compiledNegation.errors],
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
	if (out.includes(">")) out = out.replace(RE_BLOCKQUOTE_LINE, blank);
	if (out.includes("`")) out = out.replace(RE_INLINE_CODE, blank);
	if (out.includes("](file://") || out.includes("](vscode://")) {
		out = out.replace(RE_LOCAL_URI_LINK, blank);
	}
	if (out.includes("http://") || out.includes("https://")) out = out.replace(RE_HTTP_URL, blank);
	if (out.includes(":\\")) out = out.replace(RE_WIN_PATH, blank);
	if (out.includes("|")) out = out.replace(RE_MD_TABLE_ROW, blank);
	return out;
}

export function splitTypedSentences(text: string): TypedSentence[] {
	const lines = text.split(/\r?\n/);
	const out: TypedSentence[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const trimmedLine = lines[i]!.trim();
		if (!trimmedLine || RE_HORIZONTAL_RULE.test(trimmedLine)) continue;

		const headingMatch = RE_HEADING_LINE.exec(trimmedLine);
		const isHeading = Boolean(headingMatch);
		const body = isHeading
			? headingMatch![1]!.trim()
			: trimmedLine.replace(RE_LIST_PREFIX, "").trim();
		if (!body) continue;

		const parts = body.split(RE_INTRA_LINE_SENTENCE_SPLIT);
		for (let p = 0; p < parts.length; p += 1) {
			const chunk = parts[p]!.trim();
			if (chunk.length > 0) out.push({ text: chunk, isHeading });
		}
	}
	return out;
}

export function splitSentences(text: string): string[] {
	return splitTypedSentences(text).map((s) => s.text);
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

function countSentenceNegations(sentence: string, rules: CompiledRules): number {
	const cleaned = rules.negationAllowRegex ? sentence.replace(rules.negationAllowRegex, blank) : sentence;
	const spans: Array<{ start: number; end: number }> = [];
	for (let r = 0; r < rules.negationRegexes.length; r += 1) {
		const re = rules.negationRegexes[r]!.regex;
		re.lastIndex = 0;
		let matched: RegExpExecArray | null;
		while ((matched = re.exec(cleaned)) !== null) {
			const raw = matched[0] ?? "";
			if (raw.length === 0) {
				re.lastIndex += 1;
				continue;
			}
			const trimmed = raw.replace(RE_LEADING_NEG_DELIM, "");
			const tokenLen = (trimmed || raw).length;
			const start = matched.index + (raw.length - tokenLen);
			const end = matched.index + raw.length;
			spans.push({ start, end });
		}
	}
	if (spans.length <= 1) return spans.length;
	spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
	let count = 0;
	let lastEnd = -1;
	for (let i = 0; i < spans.length; i += 1) {
		const span = spans[i]!;
		if (span.start < lastEnd) continue;
		count += 1;
		lastEnd = span.end;
	}
	return count;
}

export function computeNegationBudget(proseSentenceCount: number, ratio = 3): number {
	if (proseSentenceCount <= 2) return 1;
	return Math.max(2, Math.ceil(proseSentenceCount / Math.max(1, ratio)));
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

	const needTypedSentences = rules.regexes.length > 0 || rules.negationRegexes.length > 0;
	const typedSentences = needTypedSentences ? splitTypedSentences(masked) : [];

	if (rules.regexes.length > 0) {
		const minSentences = config.regex_min_sentences;
		const sentenceCount = typedSentences.length;
		if (sentenceCount >= minSentences) {
			for (let r = 0; r < rules.regexes.length; r += 1) {
				const compiled = rules.regexes[r]!;
				let count = 0;
				let first = "";
				for (let s = 0; s < sentenceCount; s += 1) {
					if (count + (sentenceCount - s) < minSentences) break;
					const sentence = typedSentences[s]!.text;
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

	if (rules.negationRegexes.length > 0 && typedSentences.length > 0) {
		const ratio = config.negation_sentence_ratio ?? 3;
		const maxPerSentence = config.negation_max_per_sentence ?? 2;
		let proseSentenceCount = 0;
		let totalNegations = 0;
		let maxInSingleSentence = 0;
		let worstSentence = "";
		const hitSamples: string[] = [];

		for (let s = 0; s < typedSentences.length; s += 1) {
			const entry = typedSentences[s]!;
			if (!entry.isHeading) proseSentenceCount += 1;
			const negCount = countSentenceNegations(entry.text, rules);
			if (negCount > 0) {
				totalNegations += negCount;
				if (hitSamples.length < 3) {
					const compact = entry.text.replace(/\s+/g, " ").trim();
					hitSamples.push(compact.length > 32 ? `${compact.slice(0, 29)}...` : compact);
				}
				if (negCount > maxInSingleSentence) {
					maxInSingleSentence = negCount;
					worstSentence = entry.text;
				}
			}
		}

		const budget = computeNegationBudget(proseSentenceCount, ratio);
		if (maxInSingleSentence > maxPerSentence) {
			hits.push({
				kind: "negation",
				rule: "单句否定堆叠",
				match: worstSentence,
				count: maxInSingleSentence,
				budget: maxPerSentence,
			});
		} else if (totalNegations > budget) {
			hits.push({
				kind: "negation",
				rule: "否定密度超标",
				match: hitSamples.join(" / "),
				count: totalNegations,
				budget,
			});
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

function formatHitSummary(hits: Hit[]): string {
	const labels = hits.map((hit) => {
		if (hit.kind === "negation" && hit.budget !== undefined) {
			return `${hit.rule} (${hit.count}/${hit.budget})`;
		}
		const text = (hit.match || hit.rule).replace(/\s+/g, " ").trim();
		const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text;
		const count = hit.count > 1 ? ` ×${hit.count}${hit.kind === "regex" ? " 句" : ""}` : "";
		return `${clipped}${count}`;
	});
	const shown = labels.slice(0, 6);
	const more = labels.length > shown.length ? ` 等 ${labels.length} 项` : "";
	return shown.length ? shown.join("、") + more : "黑名单规则";
}

export function renderNotice(hits: Hit[], stopped: boolean): string {
	const summary = formatHitSummary(hits);
	if (stopped) {
		return `> ⚠️ 文风自动改写已达上限（命中：${summary}）；原回复保留。`;
	}
	return [`> ⚠️ 输出不合规，已回滚`, `> 命中：${summary}`, `> 正在原位改写…`].join("\n");
}

export function renderStoppedReply(hits: Hit[], body: string): string {
	const notice = renderNotice(hits, true);
	const trimmed = body.trim();
	return trimmed ? `${notice}\n\n${body}` : notice;
}

export function buildFeedback(hits: Hit[], originalDraft?: string): string {
	const rules = hits.map((hit) => {
		const matched = (hit.match || hit.rule).replace(/\s+/g, " ").trim();
		const clipped = matched.length > 80 ? `${matched.slice(0, 77)}...` : matched;
		if (hit.kind === "tail_regex") {
			return `末尾追问/客套规则 ${hit.rule}（匹配：${clipped}）`;
		}
		if (hit.kind === "negation") {
			const limitInfo =
				hit.budget !== undefined ? `计 ${hit.count} 次，上限 ${hit.budget}` : `${hit.count} 次`;
			return `${hit.rule}（${limitInfo}；定位：${clipped}）`;
		}
		const count = hit.count > 1 ? `，${hit.count} ${hit.kind === "regex" ? "句" : "次"}` : "";
		return hit.kind === "regex"
			? `${hit.rule}（匹配：${clipped}${count}）`
			: `${hit.rule}${count}`;
	});
	const uniqueRules = [...new Set(rules)];
	const onlyTail = hits.length > 0 && hits.every((h) => h.kind === "tail_regex");
	const hasTailHit = hits.some((h) => h.kind === "tail_regex");
	const hasNegationHit = hits.some((h) => h.kind === "negation");
	let instruction: string;
	if (onlyTail) {
		instruction =
			"请基于上一条回复，直接删除末尾未授权的追问、菜单式选择题或客套话；其余段落、数据、代码、命令与结论逐字原样保留；不要解释，不要提审查，直接输出修改后的完整回复。";
	} else if (hasNegationHit) {
		instruction = hasTailHit
			? "请仅原位改写命中的否定堆叠句子（改为肯定句陈述当前落点、变更范围与下一步，保留真实阻塞项），并直接删除末尾未授权追问或客套话；其余未命中的段落、数据、代码、命令与结论逐字原样保留；不要解释，不要提审查，直接输出修改后的完整回复。"
			: "请仅原位改写命中的否定堆叠句子（改为肯定句陈述当前落点、变更范围与下一步，保留真实阻塞项）；其余未命中的段落、数据、代码、命令与结论逐字原样保留；不要解释，不要提审查，直接输出修改后的完整回复。";
	} else {
		instruction = hasTailHit
			? "请仅原位改写命中的句子，并直接删除末尾未授权追问或客套话；其余未命中的段落、数据、代码、命令与结论逐字原样保留；不要解释，不要提审查，直接输出修改后的完整回复。"
			: "请仅原位改写命中的句子；其余未命中的段落、数据、代码、命令与结论逐字原样保留；不要解释，不要提审查，直接输出修改后的完整回复。";
	}
	const lines = [
		"你上一条回复命中了文风规则：",
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

function hasRetryMarker(message: any): boolean {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
	for (let i = 0; i < message.content.length; i += 1) {
		const block = message.content[i];
		if (block?.type === "text" && typeof block.text === "string" && block.text.includes(MARKER_RETRY)) {
			return true;
		}
	}
	return false;
}

function isSupersededByLaterAssistant(messages: any[], index: number): boolean {
	for (let k = index + 1; k < messages.length; k += 1) {
		const role = messages[k]?.role;
		if (role === "user") return false;
		if (role === "assistant") return true;
	}
	return false;
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
	if (stopped) {
		const body = stripMarkers(textOf(message));
		return { ...message, content: [{ type: "text", text: marker + renderStoppedReply(hits, body) }] };
	}
	return { ...message, content: [{ type: "text", text: marker + renderNotice(hits, false) }] };
}

function logAudit(message: any, hits: Hit[], action: "retry" | "stopped"): void {
	const line = `${JSON.stringify({
		ts: new Date().toISOString(),
		provider: message.provider,
		model: message.model,
		action,
		hits: hits.map((hit) => ({
			kind: hit.kind,
			rule: hit.rule,
			match: hit.match,
			count: hit.count,
			...(hit.budget !== undefined ? { budget: hit.budget } : {}),
		})),
	})}\n`;
	void fs.promises.appendFile(LOG_PATH, line, "utf8").catch(() => {
		// Logging must not break the reply.
	});
}

function setStatus(ctx: any, text: string | undefined): void {
	if (ctx?.hasUI) ctx.ui.setStatus("plain-check", text);
}

function cacheNotice(cache: Map<string, string>, key: string, value: string): void {
	if (cache.size >= MAX_NOTICE_CACHE && !cache.has(key)) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

function totalRuleCount(rules: CompiledRules): number {
	return (
		rules.keywords.length +
		rules.regexes.length +
		rules.negationRegexes.length +
		rules.tailRegexes.length
	);
}

function isSubagentChild(): boolean {
	const raw = process.env.PI_SUBAGENT_CHILD?.trim().toLowerCase();
	return Boolean(raw && raw !== "0" && raw !== "false");
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
			if (ctx.hasUI && (ctx as any).mode === "tui") {
				ctx.ui.setStatus(
					"plain-check",
					config.enabled ? `plain-check: ${totalRuleCount(rules)} 条` : "plain-check: off",
				);
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
		if (!config.enabled || isSubagentChild()) return;
		const message = event.message as any;
		if (!isFinalAssistant(message)) return;
		const draft = textOf(message);
		if (!draft.trim()) return;
		const hits = auditText(draft, config, rules);
		if (hits.length === 0) {
			pendingRewrite = false;
			setStatus(ctx, undefined);
			return;
		}

		const tui = (ctx as any).mode === "tui";
		const cleanDraft = stripMarkers(draft);
		const onlyNegation = hits.every((h) => h.kind === "negation");
		const effectiveMaxRetries = onlyNegation
			? Math.min(config.max_retries, config.negation_max_retries ?? 1)
			: config.max_retries;
		const canRetry = attempts < effectiveMaxRetries;
		if (!canRetry) {
			logAudit(message, hits, "stopped");
			pendingRewrite = false;
			setStatus(ctx, `plain-check: 命中 ${hits.length} 项，保留原回复`);
			const rolled = rollbackMessage(message, MARKER_STOP, hits, true, tui);
			if (tui) {
				cacheNotice(noticeCache, textOf(rolled), renderStoppedReply(hits, cleanDraft));
			}
			return { message: rolled };
		}

		attempts += 1;
		logAudit(message, hits, "retry");
		setStatus(ctx, `plain-check: 命中 ${hits.length} 项，重写中 (${attempts}/${effectiveMaxRetries})`);
		try {
			pi.sendMessage(
				{
					customType: REWRITE_TYPE,
					content: buildFeedback(hits, tui ? undefined : cleanDraft),
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			pendingRewrite = true;
		} catch {
			pendingRewrite = false;
			const rolled = rollbackMessage(message, MARKER_STOP, hits, true, tui);
			if (tui) {
				cacheNotice(noticeCache, textOf(rolled), renderStoppedReply(hits, cleanDraft));
			}
			return { message: rolled };
		}
		const rolled = rollbackMessage(message, MARKER_RETRY, hits, false, tui);
		if (tui) {
			cacheNotice(noticeCache, textOf(rolled), cleanDraft);
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
		const rendered = marker === MARKER_STOP ? renderStoppedReply(auditText(text, config, rules), text) : text;
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
				if (hasRetryMarker(msg) && isSupersededByLaterAssistant(rawMessages, i)) {
					continue;
				}
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
						`已重载：${rules.keywords.length} keyword，${rules.regexes.length} regex，${rules.negationRegexes.length} negation，${rules.tailRegexes.length} tail_regex，max_retries=${config.max_retries}`,
						"info",
					);
					if (rules.errors.length > 0) {
						notify(`有 ${rules.errors.length} 条 regex 无效`, "warning");
					}
					return;
				}

				if (action === "on" || action === "off") {
					config = { ...config, enabled: action === "on" };
					setStatus(ctx, config.enabled ? undefined : "plain-check: off");
					notify(`plain-check ${config.enabled ? "on" : "off"}`, "info");
					return;
				}

				notify(
					`plain-check ${config.enabled ? "on" : "off"}；${rules.keywords.length} keyword，${rules.regexes.length} regex，${rules.negationRegexes.length} negation，${rules.tailRegexes.length} tail_regex；max_retries=${config.max_retries}；配置：${activeConfigPath}`,
					"info",
				);
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
