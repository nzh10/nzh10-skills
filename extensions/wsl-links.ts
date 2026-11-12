import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PLAIN_CHECK_MARKER = "<!-- plain-check:";
const MAX_TRANSFORM_CACHE = 256;
const MAX_STAT_CACHE = 512;

const BROWSER_OR_SHELL_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
]);

export interface PathStatInfo {
  exists: boolean;
  isDir: boolean;
}

export interface WslLinkOptions {
  distro: string;
  homeDir?: string;
  statPath?: (absPath: string) => PathStatInfo;
}

function defaultStatFactory(): (absPath: string) => PathStatInfo {
  const cache = new Map<string, PathStatInfo>();
  return (absPath: string): PathStatInfo => {
    const cached = cache.get(absPath);
    if (cached !== undefined) return cached;
    let info: PathStatInfo;
    try {
      const st = fs.statSync(absPath);
      info = { exists: true, isDir: st.isDirectory() };
    } catch {
      info = { exists: false, isDir: false };
    }
    if (cache.size >= MAX_STAT_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(absPath, info);
    return info;
  };
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function encodePosixSegments(posixPath: string): string {
  return posixPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parsePosixTarget(
  rawInput: string,
  homeDir: string,
): { posixPath: string; line?: number; col?: number } | undefined {
  let working = rawInput.trim();
  if (!working) return undefined;

  let fragment = "";
  const hashIdx = working.indexOf("#");
  if (hashIdx >= 0) {
    fragment = working.slice(hashIdx + 1);
    working = working.slice(0, hashIdx);
  }

  // Strip query string if present on file:// URLs
  const queryIdx = working.indexOf("?");
  if (queryIdx >= 0) {
    working = working.slice(0, queryIdx);
  }

  if (working.startsWith("file://")) {
    // Already Windows drive URI (file:///C:/...) or WSL UNC URI (file://wsl.localhost/...)
    if (/^file:\/\/\/[A-Za-z]:\//.test(working) || /^file:\/\/(?:wsl\.localhost|wsl\$)\//i.test(working)) {
      return undefined;
    }
    const rest = working.slice("file://".length);
    if (rest.startsWith("/")) {
      // Collapse file:////... or file:///... to a single leading /
      working = "/" + rest.replace(/^\/+/, "");
    } else {
      // file://<linux-host>/path -> /path
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 0) return undefined;
      working = rest.slice(slashIdx);
    }
    working = safeDecode(working);
  } else if (working === "~") {
    working = homeDir;
  } else if (working.startsWith("~/")) {
    working = path.posix.join(homeDir, working.slice(2));
  } else if (!working.startsWith("/")) {
    return undefined;
  }

  let line: number | undefined;
  let col: number | undefined;

  if (fragment) {
    const fragMatch = /^L?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment);
    if (fragMatch) {
      line = Number(fragMatch[1]);
      if (fragMatch[2]) col = Number(fragMatch[2]);
    }
  }

  const colonMatch = /^(.*):(\d+)(?::(\d+)|-\d+)?$/.exec(working);
  if (colonMatch && colonMatch[1]) {
    working = colonMatch[1];
    if (line === undefined) {
      line = Number(colonMatch[2]);
      if (colonMatch[3]) col = Number(colonMatch[3]);
    }
  }

  if (!working.startsWith("/")) return undefined;
  return { posixPath: working, line, col };
}

export function toWslClickableUri(rawInput: string, options: WslLinkOptions): string | undefined {
  const distro = options.distro.trim();
  if (!distro) return undefined;
  const homeDir = options.homeDir ?? os.homedir();
  const statPath = options.statPath;

  // Fix vscode://vscode-remote/wsl+<distro>/path links missing :line for non-directory files
  const vscodeRemoteMatch = /^(vscode(?:-insiders)?:\/\/vscode-remote\/wsl(?:\+|%2B)[^/]+)(\/[^:#?\s]+)$/i.exec(
    rawInput.trim(),
  );
  if (vscodeRemoteMatch) {
    const prefix = vscodeRemoteMatch[1]!;
    const rawRemotePath = vscodeRemoteMatch[2]!;
    const decodedPath = safeDecode(rawRemotePath);
    if (decodedPath.endsWith("/")) return undefined;
    const info = statPath?.(decodedPath);
    if (info?.isDir) return undefined;
    return `${prefix}${rawRemotePath}:1`;
  }

  const parsed = parsePosixTarget(rawInput, homeDir);
  if (!parsed) return undefined;

  const { posixPath, line, col } = parsed;
  const hasTrailingSlash = posixPath.length > 1 && posixPath.endsWith("/");
  const cleanPath = hasTrailingSlash ? posixPath.replace(/\/+$/, "") : posixPath;
  const ext = path.posix.extname(cleanPath).toLowerCase();
  const info = statPath?.(cleanPath);
  const isDirectory = hasTrailingSlash || Boolean(info?.isDir);
  const openWithShell = isDirectory || BROWSER_OR_SHELL_EXTENSIONS.has(ext);

  const mntMatch = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(cleanPath);
  if (mntMatch) {
    const drive = mntMatch[1]!.toUpperCase();
    const rest = mntMatch[2] ? encodePosixSegments(mntMatch[2]) : "";
    if (openWithShell) {
      const trailing = isDirectory && rest ? "/" : "";
      return `file:///${drive}:/${rest}${trailing}`;
    }
    const lineSuffix = `:${line ?? 1}${col ? `:${col}` : ""}`;
    return `vscode://file/${drive}:/${rest}${lineSuffix}`;
  }

  const encodedDistro = encodeURIComponent(distro);
  const encodedPath = encodePosixSegments(cleanPath);
  if (openWithShell) {
    const trailing = isDirectory && cleanPath !== "/" ? "/" : "";
    return `file://wsl.localhost/${encodedDistro}${encodedPath}${trailing}`;
  }
  const lineSuffix = `:${line ?? 1}${col ? `:${col}` : ""}`;
  return `vscode://vscode-remote/wsl+${encodedDistro}${encodedPath}${lineSuffix}`;
}

const INLINE_TOKEN_RE = /(!?\[(?:`[^`\n]+`|[^\]\n])+\]\(([^)\s]+)\))|(`+)([^`\n]+)\3/g;
const CODE_SPAN_PATH_PREFIX_RE = /^(?:~\/|\/home\/|\/mnt\/[a-zA-Z]\/|\/tmp\/|\/etc\/|\/opt\/|\/var\/)/;
const CODE_SPAN_DISALLOWED_RE = /[\s*$?|<>;'"\\]/;

function transformInlineLine(line: string, options: Required<WslLinkOptions>): string {
  if (!line.includes("](") && !line.includes("`")) {
    return line;
  }
  INLINE_TOKEN_RE.lastIndex = 0;
  return line.replace(
    INLINE_TOKEN_RE,
    (fullMatch, mdLink: string | undefined, mdHref: string | undefined, ticks: string | undefined, codeText: string | undefined) => {
      if (mdLink !== undefined && mdHref !== undefined) {
        if (mdLink.startsWith("!")) return fullMatch;
        const rewritten = toWslClickableUri(mdHref, options);
        if (!rewritten || rewritten === mdHref) return fullMatch;
        const closeBracketIdx = mdLink.lastIndexOf("](");
        if (closeBracketIdx < 0) return fullMatch;
        return `${mdLink.slice(0, closeBracketIdx + 2)}${rewritten})`;
      }

      if (ticks !== undefined && codeText !== undefined) {
        if (!CODE_SPAN_PATH_PREFIX_RE.test(codeText) || CODE_SPAN_DISALLOWED_RE.test(codeText)) {
          return fullMatch;
        }
        const parsed = parsePosixTarget(codeText, options.homeDir);
        if (!parsed || parsed.posixPath === options.homeDir) {
          return fullMatch;
        }
        const cleanPath = parsed.posixPath.length > 1 ? parsed.posixPath.replace(/\/+$/, "") : parsed.posixPath;
        const stat = options.statPath(cleanPath);
        if (!stat.exists) {
          return fullMatch;
        }
        const rewritten = toWslClickableUri(codeText, options);
        if (!rewritten) return fullMatch;
        return `[${fullMatch}](${rewritten})`;
      }

      return fullMatch;
    },
  );
}

export function rewriteWslMarkdownLinks(markdown: string, options: WslLinkOptions): string {
  if (!markdown || markdown.startsWith(PLAIN_CHECK_MARKER)) {
    return markdown;
  }
  if (!markdown.includes("](") && !markdown.includes("`")) {
    return markdown;
  }

  const resolved: Required<WslLinkOptions> = {
    distro: options.distro,
    homeDir: options.homeDir ?? os.homedir(),
    statPath: options.statPath ?? defaultStatFactory(),
  };

  const lines = markdown.split("\n");
  let fenceChar = "";
  let fenceLen = 0;
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const rest = fenceMatch[2] ?? "";
      if (!fenceChar) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && rest.trim() === "") {
        fenceChar = "";
        fenceLen = 0;
        continue;
      }
    }

    if (fenceChar) continue;

    const nextLine = transformInlineLine(line, resolved);
    if (nextLine !== line) {
      lines[i] = nextLine;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : markdown;
}

export default function wslLinks(pi: ExtensionAPI): void {
  const distro = process.env.WSL_DISTRO_NAME?.trim();
  const isWindowsTerminal = Boolean(process.env.WT_SESSION?.trim());
  if (!distro || !isWindowsTerminal) {
    return;
  }

  const homeDir = os.homedir();
  const statPath = defaultStatFactory();
  const renderCache = new Map<string, string>();

  (pi as any).registerMarkdownTransformer((markdown: string) => {
    if (!markdown || markdown.startsWith(PLAIN_CHECK_MARKER)) {
      return markdown;
    }
    const cached = renderCache.get(markdown);
    if (cached !== undefined) {
      return cached;
    }
    const transformed = rewriteWslMarkdownLinks(markdown, { distro, homeDir, statPath });
    if (renderCache.size >= MAX_TRANSFORM_CACHE) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined) renderCache.delete(oldest);
    }
    renderCache.set(markdown, transformed);
    return transformed;
  });
}
