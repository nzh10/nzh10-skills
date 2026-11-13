#!/bin/sh
# Deterministic 4-step preflight gate for pi-steward write operations.
# Uses Node (guaranteed present with Pi) to avoid jq/python3 cold-start dependencies.
set -eu

AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
MARKER_PATH="${AGENT_DIR}/machine.json"

if [ ! -f "$MARKER_PATH" ]; then
  echo "PREFLIGHT_FAIL[1/4]: Missing ${MARKER_PATH} (current machine is a read-only sync node)." >&2
  exit 1
fi

PARSED=$(node -e '
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const agentDir = process.argv[1];
  const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "machine.json"), "utf8"));
  const expand = (p) => p === "~" ? os.homedir() : p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;
  const real = (p) => { try { return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p); } catch { return path.resolve(p); } };
  if (!raw.machineId || !raw.hubRepoPath) {
    console.error("PREFLIGHT_FAIL[1/4]: machineId or hubRepoPath missing in machine.json (read-only node).");
    process.exit(1);
  }
  const hub = real(expand(String(raw.hubRepoPath).trim()));
  const cacheRoot = real(path.join(agentDir, "git"));
  const rel = path.relative(cacheRoot, hub);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    console.error("PREFLIGHT_FAIL[1/4]: hubRepoPath points inside package cache (" + hub + ").");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(hub, ".git")) || !fs.existsSync(path.join(hub, "canon"))) {
    console.error("PREFLIGHT_FAIL[1/4]: hubRepoPath missing .git or canon/: " + hub);
    process.exit(1);
  }
  process.stdout.write(raw.machineId + "\n" + hub + "\n");
' "$AGENT_DIR")

MACHINE_ID=$(printf '%s\n' "$PARSED" | sed -n '1p')
HUB_REPO=$(printf '%s\n' "$PARSED" | sed -n '2p')

GIT_BIN="git"
if [ -x /usr/bin/git ]; then
  GIT_BIN="/usr/bin/git"
fi

HOOKS_PATH=$("$GIT_BIN" -C "$HUB_REPO" config --get core.hooksPath 2>/dev/null || true)
if [ "$HOOKS_PATH" != ".githooks" ]; then
  echo "PREFLIGHT_FAIL[2/4]: core.hooksPath is '${HOOKS_PATH:-unset}' (expected '.githooks'). Run /hub-init ${MACHINE_ID} ${HUB_REPO}." >&2
  exit 1
fi

DENYLIST=$("$GIT_BIN" -C "$HUB_REPO" rev-parse --path-format=absolute --git-path info/no-upload-personal)
if [ ! -s "$DENYLIST" ]; then
  echo "PREFLIGHT_FAIL[2/4]: Missing or empty personal denylist at ${DENYLIST}." >&2
  exit 1
fi

STAGED=$("$GIT_BIN" -C "$HUB_REPO" diff --cached --name-only)
if [ -n "$STAGED" ]; then
  echo "PREFLIGHT_FAIL[3/4]: Unrelated staged files already in index:" >&2
  printf '%s\n' "$STAGED" >&2
  exit 1
fi

node -e '
  const { execFileSync } = require("node:child_process");
  const gitBin = process.argv[1];
  const repo = process.argv[2];
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE || "");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=8",
  };
  if (!offline) {
    try {
      execFileSync(gitBin, ["-C", repo, "fetch", "--quiet", "origin"], {
        timeout: 10000,
        stdio: ["ignore", "ignore", "pipe"],
        env,
      });
    } catch {
      // Offline or transient network issue; still compare against known upstream ref below
    }
  }
  let counts = "";
  try {
    counts = execFileSync(gitBin, ["-C", repo, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch {
    process.exit(0);
  }
  const parts = counts.split(/\s+/);
  const behind = Number(parts[1] || 0);
  if (behind > 0) {
    console.error(
      `PREFLIGHT_FAIL[4/4]: ${repo} is behind upstream by ${behind} commit(s); run "git -C ${repo} pull --ff-only" first.`,
    );
    process.exit(1);
  }
' "$GIT_BIN" "$HUB_REPO"

printf 'PREFLIGHT_OK machineId=%s hubRepoPath=%s\n' "$MACHINE_ID" "$HUB_REPO"
"$GIT_BIN" -C "$HUB_REPO" status --short

