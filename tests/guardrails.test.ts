import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditText,
  buildFeedback,
  compileRules,
  extractTailSegment,
  loadConfig,
} from "../extensions/plain-check.ts";
import registerPiSteward, {
  computeStewardDiff,
  evaluateToolCallGuard,
  formatHubStatusText,
  handleStewardTerminalInput,
  normalizeTerminalInputSequence,
  runInCacheCriticalSection,
  syncCacheRepoToUpstream,
} from "../extensions/pi-steward.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANON_TOML = path.join(REPO_ROOT, "canon", "plain-check.toml");

test("plain-check tail_regex intercepts closing menus, unrequested offers, and timid cleanup prompts", () => {
  const { config } = loadConfig(CANON_TOML);
  const rules = compileRules(config);
  assert.equal(rules.errors.length, 0);

  const badClosings = [
    "已完成第 1 项配置修复并写入提交。\n\n剩下第 2 项和第 3 项。这两项我现在直接做完，还是只做其中一项？",
    "已完成本地提交 `910a760`。需要我顺手 push 到远端吗？",
    "配置校验已全部通过。要不要我继续把全量评测耗时也压一下？",
    "这个目录每天自动同步上游，写在这里会有冲突风险。同意的话我把它删了？",
    "主线脚本已更新完毕。如果你需要，我可以继续整理其余文档。",
  ];

  for (const sample of badClosings) {
    const hits = auditText(sample, config, rules);
    assert.ok(
      hits.some((h) => h.kind === "tail_regex"),
      `Expected tail_regex hit for sample: ${sample}`,
    );
  }
});

test("plain-check tail_regex has zero false positives on blockers, engineering pushback, quotes, and code", () => {
  const { config } = loadConfig(CANON_TOML);
  const rules = compileRules(config);

  const legitimateReplies = [
    "当前环境缺少 `NOTION_TOKEN` 与测试页面 ID，请提供测试页面 ID 后再执行真实写入验证。",
    "使用 `ADD:`/`MOD:` 前缀会破坏标准 Conventional Commits 工具链并与本仓历史冲突，建议保持 `feat:`/`fix:`/`chore:`。请确认是否按标准前缀提交？",
    "这里的超时阈值是指单次 HTTP 请求上限，还是整轮批处理总耗时上限？",
    "发现上月遗留的配置文件 `~/legacy.json`（非本次会话生成），删除前请确认是否保留备份？",
    "用户原话引用如下：\n> 需要我顺手把远端也推了吗？\n\n已完成本地清理并停止。",
    "验证命令如下：\n```sh\n# 需要我顺手测试吗？\ngit status -sb\n```",
  ];

  for (const sample of legitimateReplies) {
    const hits = auditText(sample, config, rules);
    assert.deepEqual(hits, [], `Unexpected hit on legitimate reply: ${sample} -> ${JSON.stringify(hits)}`);
  }

  assert.equal(
    extractTailSegment("第一句结论。第二句证据。第三句收尾？"),
    "第二句证据。 第三句收尾？",
  );
});

test("plain-check buildFeedback preserves original draft in non-TUI mode", () => {
  const draft = "已完成提交 abc1234。需要我顺手推上去吗？";
  const fbHeadless = buildFeedback(
    [{ kind: "tail_regex", rule: "需要我.*[吗？?]", match: "需要我顺手推上去吗？", count: 1 }],
    draft,
  );
  assert.match(fbHeadless, /<previous_draft>[\s\S]*abc1234[\s\S]*<\/previous_draft>/);

  const fbTui = buildFeedback([
    { kind: "tail_regex", rule: "需要我.*[吗？?]", match: "需要我顺手推上去吗？", count: 1 },
  ]);
  assert.doesNotMatch(fbTui, /<previous_draft>/);
});

test("pi-steward evaluateToolCallGuard blocks only hook-bypass flags and imposes zero barrier on git push or skill-creator edits", () => {
  for (const badCmd of [
    'git commit --no-verify -m "chore: bypass"',
    'git commit -am "chore: bypass" -n',
    "git push --no-verify origin master",
    'git -c core.hooksPath=/dev/null commit -m "chore: bypass"',
  ]) {
    for (const toolName of ["bash", "powershell"]) {
      const res = evaluateToolCallGuard({ toolName, input: { command: badCmd } });
      assert.equal(res?.block, true, `Expected block for ${toolName}: ${badCmd}`);
    }
  }

  for (const allowedCall of [
    { toolName: "bash", input: { command: "git push origin master" } },
    { toolName: "bash", input: { command: "git push -n origin master" } },
    { toolName: "bash", input: { command: 'git commit -m "feat: block --no-verify flag"' } },
    { toolName: "bash", input: { command: 'git revert --no-edit HEAD' } },
    { toolName: "edit", input: { path: "skills/skill-creator/scripts/run_eval.py" } },
    { toolName: "write", input: { path: "skills/skill-creator/SKILL.md" } },
  ]) {
    assert.equal(
      evaluateToolCallGuard(allowedCall),
      undefined,
      `Expected no barrier for: ${JSON.stringify(allowedCall)}`,
    );
  }
});

test("pi-steward overwrites stale plain-check.toml from canon just like AGENTS.md", () => {
  const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "steward-test-"));
  try {
    fs.writeFileSync(path.join(tmpAgent, "plain-check.toml"), "enabled = true\nkeywords = []\n", "utf8");
    const diff = computeStewardDiff(REPO_ROOT, tmpAgent);
    const pcDiff = diff.fileChanges.find((f) => f.targetName === "plain-check.toml");
    assert.ok(pcDiff);
    assert.equal(pcDiff.policy, "overwrite");
    assert.equal(pcDiff.changed, true);
  } finally {
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
});

test("pi-steward syncCacheRepoToUpstream resets package cache to rewritten origin without touching repos outside cache", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-cache-"));
  try {
    const bareOrigin = path.join(tmpRoot, "origin.git");
    const workRepo = path.join(tmpRoot, "hub");
    const agentDir = path.join(tmpRoot, "agent");
    const cacheRepo = path.join(agentDir, "git", "github.com", "nzh10", "nzh10-skills");

    execFileSync("git", ["init", "--bare", "-q", bareOrigin]);
    execFileSync("git", ["clone", "-q", bareOrigin, workRepo]);
    execFileSync("git", ["-C", workRepo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", workRepo, "config", "user.email", "1+test@users.noreply.github.com"]);
    fs.writeFileSync(path.join(workRepo, "v.txt"), "v1\n", "utf8");
    execFileSync("git", ["-C", workRepo, "add", "v.txt"]);
    execFileSync("git", ["-C", workRepo, "commit", "-q", "-m", "chore: v1"]);
    execFileSync("git", ["-C", workRepo, "push", "-q", "-u", "origin", "HEAD"]);

    fs.mkdirSync(path.dirname(cacheRepo), { recursive: true });
    execFileSync("git", ["clone", "-q", bareOrigin, cacheRepo]);

    // Simulate cache having diverged local commit AND origin getting an amended force-push
    execFileSync("git", ["-C", cacheRepo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", cacheRepo, "config", "user.email", "1+test@users.noreply.github.com"]);
    fs.writeFileSync(path.join(cacheRepo, "v.txt"), "stale-cache\n", "utf8");
    execFileSync("git", ["-C", cacheRepo, "commit", "-q", "-am", "chore: stale"]);

    fs.writeFileSync(path.join(workRepo, "v.txt"), "v2-published\n", "utf8");
    execFileSync("git", ["-C", workRepo, "commit", "-q", "--amend", "-am", "chore: v2"]);
    execFileSync("git", ["-C", workRepo, "push", "-q", "--force", "origin", "HEAD"]);

    // Add unpushed dirty work in workRepo and verify syncCacheRepoToUpstream refuses to reset workRepo
    fs.writeFileSync(path.join(workRepo, "v.txt"), "unpushed-hub-edit\n", "utf8");
    await syncCacheRepoToUpstream(workRepo, agentDir);
    assert.equal(fs.readFileSync(path.join(workRepo, "v.txt"), "utf8"), "unpushed-hub-edit\n");

    // Reconcile actual cacheRepo -> hard-resets to published origin v2 and reports changed: true
    const res = await syncCacheRepoToUpstream(cacheRepo, agentDir);
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.ok(res.shortSha && res.shortSha.length >= 7);
    assert.equal(fs.readFileSync(path.join(cacheRepo, "v.txt"), "utf8"), "v2-published\n");

    // Second sync at same upstream SHA reports changed: false
    const resNoop = await syncCacheRepoToUpstream(cacheRepo, agentDir);
    assert.equal(resNoop.ok, true);
    assert.equal(resNoop.changed, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("pi-steward serializes cache critical section and reports accurate /hub-status direction when hub lags upstream", async () => {
  const order: string[] = [];
  const first = runInCacheCriticalSection(async () => {
    order.push("reset-start");
    await new Promise((r) => setTimeout(r, 25));
    order.push("reset-end");
  });
  const second = runInCacheCriticalSection(async () => {
    order.push("reconcile-start");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["reset-start", "reset-end", "reconcile-start"]);

  const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "steward-status-"));
  try {
    const diff = computeStewardDiff(REPO_ROOT, tmpAgent);
    const laggingHubStatus = formatHubStatusText(diff, tmpAgent, {
      dirtyCount: 0,
      aheadCount: 0,
      behindCount: 2,
      cacheMismatch: true,
      cacheMatchesUpstream: true,
    });
    assert.match(laggingHubStatus.text, /工作仓落后远端 2 个提交/);
    assert.doesNotMatch(laggingHubStatus.text, /包缓存/);
  } finally {
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
});

test("skill-creator run_eval.py parses triggered event even when pi exits immediately before loop poll", () => {
  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
  try {
    const fakePi = path.join(tmpBin, "pi");
    fs.writeFileSync(
      fakePi,
      [
        "#!/usr/bin/env python3",
        "import json, sys",
        "args = sys.argv[1:]",
        "skill_dir = args[args.index('--skill') + 1]",
        "sys.stdin.read()",
        "print(json.dumps({'type': 'tool_execution_start', 'toolName': 'read', 'args': {'path': skill_dir + '/SKILL.md'}}), flush=True)",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const out = execFileSync(
      "python3",
      [
        "-c",
        "from scripts.run_eval import run_single_query; print(run_single_query('hello', 'demo', 'desc', 5, '.'))",
      ],
      {
        cwd: path.join(REPO_ROOT, "skills", "skill-creator"),
        env: { ...process.env, PATH: `${tmpBin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    ).trim();
    assert.equal(out, "True");
  } finally {
    fs.rmSync(tmpBin, { recursive: true, force: true });
  }
});

test("steward-preflight.sh fails read-only when behind upstream without mutating dirty worktree", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
  try {
    const bareOrigin = path.join(tmpRoot, "origin.git");
    const peerRepo = path.join(tmpRoot, "peer");
    const hubRepo = path.join(tmpRoot, "hub");
    const agentDir = path.join(tmpRoot, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    execFileSync("git", ["init", "--bare", "-q", bareOrigin]);
    execFileSync("git", ["clone", "-q", bareOrigin, peerRepo]);
    execFileSync("git", ["-C", peerRepo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", peerRepo, "config", "user.email", "1+test@users.noreply.github.com"]);
    fs.mkdirSync(path.join(peerRepo, "canon"), { recursive: true });
    fs.writeFileSync(path.join(peerRepo, "canon", "AGENTS.md"), "# rules\n", "utf8");
    execFileSync("git", ["-C", peerRepo, "add", "canon/AGENTS.md"]);
    execFileSync("git", ["-C", peerRepo, "commit", "-q", "-m", "chore: init"]);
    execFileSync("git", ["-C", peerRepo, "push", "-q", "-u", "origin", "HEAD"]);

    execFileSync("git", ["clone", "-q", bareOrigin, hubRepo]);
    execFileSync("git", ["-C", hubRepo, "config", "core.hooksPath", ".githooks"]);
    fs.mkdirSync(path.join(hubRepo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(hubRepo, ".git", "info", "no-upload-personal"), "secret-token\n", "utf8");
    fs.writeFileSync(
      path.join(agentDir, "machine.json"),
      JSON.stringify({ machineId: "test-hub", hubRepoPath: hubRepo }),
      "utf8",
    );

    // Advance origin via peerRepo while hubRepo has an unstaged edit
    fs.writeFileSync(path.join(peerRepo, "canon", "AGENTS.md"), "# updated upstream\n", "utf8");
    execFileSync("git", ["-C", peerRepo, "commit", "-q", "-am", "chore: upstream update"]);
    execFileSync("git", ["-C", peerRepo, "push", "-q", "origin", "HEAD"]);

    fs.writeFileSync(path.join(hubRepo, "canon", "AGENTS.md"), "# local dirty edit\n", "utf8");
    const preflightScript = path.join(REPO_ROOT, "skills", "pi-steward", "scripts", "steward-preflight.sh");

    assert.throws(() => {
      execFileSync("sh", [preflightScript], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: "pipe",
      });
    }, /behind upstream/);

    // Verify worktree file was NOT touched or overwritten
    assert.equal(fs.readFileSync(path.join(hubRepo, "canon", "AGENTS.md"), "utf8"), "# local dirty edit\n");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("no-personal-info --portable rejects Linux, macOS, WSL, and Windows home paths anywhere in tracked files", () => {
  const hookScript = path.join(REPO_ROOT, ".githooks", "no-personal-info");
  const leakedSamples = [
    ["", "home", "alice", "project"].join("/"),
    ["", "Users", "bob", ".pi"].join("/"),
    ["", "mnt", "c", "Users", "charlie", "AppData"].join("/"),
    ["C:", "Users", "dave", ".pi"].join("/"),
    JSON.stringify({ dir: ["C:", "Users", "eve", ".pi"].join("\\") }),
  ];

  for (const sample of leakedSamples) {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "portable-hook-"));
    try {
      execFileSync("git", ["init", "-q", tmpRepo]);
      execFileSync("git", ["-C", tmpRepo, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", tmpRepo, "config", "user.email", "1+test@users.noreply.github.com"]);
      fs.writeFileSync(path.join(tmpRepo, "notes.md"), `sample: ${sample}\n`, "utf8");
      execFileSync("git", ["-C", tmpRepo, "add", "notes.md"]);
      execFileSync("git", ["-C", tmpRepo, "commit", "-q", "-m", "chore: test"]);

      assert.throws(
        () => {
          execFileSync("sh", [hookScript, "--portable", "HEAD"], {
            cwd: tmpRepo,
            stdio: "pipe",
          });
        },
        /local home path/,
        `Expected --portable scan to reject sample: ${sample}`,
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  }
});

test("pi-steward normalizeTerminalInputSequence strips lock bits and folds chord codepoints without altering plain typing or paste", () => {
  // modifyOtherKeys: CapsLock (64), NumLock (128), uppercase without Shift, and fullwidth chords
  assert.equal(normalizeTerminalInputSequence("\x1b[27;5;83~"), "\x1b[27;5;115~"); // Ctrl+S (CapsLock uppercase)
  assert.equal(normalizeTerminalInputSequence("\x1b[27;69;83~"), "\x1b[27;5;115~"); // Ctrl+S + CapsLock bit
  assert.equal(normalizeTerminalInputSequence("\x1b[27;133;115~"), "\x1b[27;5;115~"); // Ctrl+s + NumLock bit
  assert.equal(normalizeTerminalInputSequence("\x1b[27;197;83~"), "\x1b[27;5;115~"); // Ctrl+S + CapsLock + NumLock
  assert.equal(normalizeTerminalInputSequence("\x1b[27;5;65363~"), "\x1b[27;5;115~"); // Ctrl+ｓ (fullwidth lower)
  assert.equal(normalizeTerminalInputSequence("\x1b[27;69;65331~"), "\x1b[27;5;115~"); // Ctrl+Ｓ (fullwidth upper + CapsLock)
  assert.equal(normalizeTerminalInputSequence("\x1b[27;5;12288~"), "\x1b[27;5;32~"); // Ctrl+　 (ideographic space)
  assert.equal(normalizeTerminalInputSequence("\x1b[27;130;13~"), "\x1b[27;2;13~"); // Shift+Enter + NumLock
  assert.equal(normalizeTerminalInputSequence("\x1b[27;70;80~"), "\x1b[27;6;80~"); // Ctrl+Shift+P + CapsLock preserves Shift
  assert.equal(normalizeTerminalInputSequence("\x1b[27;129;13~"), "\r"); // Plain Enter with NumLock only
  assert.equal(normalizeTerminalInputSequence("\x1b[27;129;9~"), "\t"); // Plain Tab with NumLock only
  assert.equal(normalizeTerminalInputSequence("\x1b[27;65;83~"), "S"); // Plain uppercase 'S' with CapsLock only

  // Kitty CSI-u: CapsLock, NumLock, alternate keys, fullwidth, and repeat/release event suffixes
  assert.equal(normalizeTerminalInputSequence("\x1b[83;5u"), "\x1b[115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[83;69u"), "\x1b[115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[83;69:3u"), "\x1b[115;5:3u"); // Key release preserved
  assert.equal(normalizeTerminalInputSequence("\x1b[83;133:2u"), "\x1b[115;5:2u"); // Key repeat preserved
  assert.equal(normalizeTerminalInputSequence("\x1b[83:83:83;69u"), "\x1b[115:83:115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[1067::83;69u"), "\x1b[1067::115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[65363;5u"), "\x1b[115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[65331;69u"), "\x1b[115;5u");
  assert.equal(normalizeTerminalInputSequence("\x1b[80;70u"), "\x1b[80;6u"); // Ctrl+Shift+P preserves Shift

  // Unchanged fast-paths: canonical chords, plain CSI-u typing, fullwidth typing, bracketed paste
  for (const unchanged of [
    "S",
    "ｓ",
    "\x1b[97u",
    "\x1b[65;2u",
    "\x1b[115;5u",
    "\x1b[27;5;115~",
    "\x1b[200~\x1b[27;69;83~\x1b[201~",
  ]) {
    assert.equal(handleStewardTerminalInput(unchanged), undefined, `Expected undefined for: ${JSON.stringify(unchanged)}`);
  }
  assert.deepEqual(handleStewardTerminalInput("\x1b[27;69;83~"), { data: "\x1b[27;5;115~" });
});

test("pi-steward registers onTerminalInput only in tui mode and cleans up on session_shutdown", async () => {
  const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "steward-tui-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = tmpAgent;
  process.env.PI_OFFLINE = "1";

  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const fakePi = {
      on(event: string, fn: (...args: unknown[]) => unknown) {
        handlers.set(event, fn);
      },
      registerCommand() {},
    };
    registerPiSteward(fakePi as unknown as Parameters<typeof registerPiSteward>[0]);

    let registeredListeners = 0;
    let unsubscribedListeners = 0;
    let activeHandler: ((data: string) => { data?: string } | undefined) | undefined;

    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify() {},
        setStatus() {},
        onTerminalInput(fn: (data: string) => { data?: string } | undefined) {
          registeredListeners += 1;
          activeHandler = fn;
          return () => {
            unsubscribedListeners += 1;
            if (activeHandler === fn) activeHandler = undefined;
          };
        },
      },
    };

    const rpcCtx = {
      ...tuiCtx,
      mode: "rpc",
    };

    await handlers.get("session_start")?.({ reason: "startup" }, rpcCtx);
    assert.equal(registeredListeners, 0);

    await handlers.get("session_start")?.({ reason: "startup" }, tuiCtx);
    assert.equal(registeredListeners, 1);
    assert.deepEqual(activeHandler?.("\x1b[83;69u"), { data: "\x1b[115;5u" });

    handlers.get("session_shutdown")?.({ reason: "reload" }, tuiCtx);
    assert.equal(unsubscribedListeners, 1);
    assert.equal(activeHandler, undefined);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
});
