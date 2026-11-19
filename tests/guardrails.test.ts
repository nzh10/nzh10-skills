import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import registerPlainCheck, {
  auditText,
  buildFeedback,
  compileRules,
  extractTailSegment,
  loadConfig,
  splitTypedSentences,
} from "../extensions/plain-check.ts";
import registerPiSteward, {
  applyStewardDiff,
  computeStewardDiff,
  createProviderVisibilityProbe,
  evaluateToolCallGuard,
  formatHubStatusText,
  handleStewardTerminalInput,
  mergeCanonModelsForPromote,
  normalizeTerminalInputSequence,
  readSyncState,
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

test("plain-check buildFeedback preserves original draft in non-TUI mode and requests in-place edits", () => {
  const draft = "已完成提交 abc1234。需要我顺手推上去吗？";
  const fbHeadless = buildFeedback(
    [{ kind: "tail_regex", rule: "需要我.*[吗？?]", match: "需要我顺手推上去吗？", count: 1 }],
    draft,
  );
  assert.match(fbHeadless, /<previous_draft>[\s\S]*abc1234[\s\S]*<\/previous_draft>/);

  const fbTui = buildFeedback([
    { kind: "negation", rule: "否定密度超标", match: "已改好，未提交、未推送", count: 2, budget: 1 },
  ]);
  assert.doesNotMatch(fbTui, /<previous_draft>/);
  assert.match(fbTui, /仅原位改写/);
});

test("plain-check negation density blocks short-reply piling, single-sentence enumeration, and repeated action disclaimers while sparing long reports", () => {
  const { config } = loadConfig(CANON_TOML);
  const rules = compileRules(config);

  // 1. Short reply piling (S=1, budget=1, N=2)
  const shortPile = auditText("已更新配置，未提交、未推送。", config, rules);
  assert.ok(shortPile.some((h) => h.kind === "negation" && h.count === 2 && h.budget === 1));

  // 2. Two short sentences with ordinary negations (S=2, budget=1, N=2)
  const twoSentencePile = auditText("路由表没动。连接池没有重建。", config, rules);
  assert.ok(twoSentencePile.some((h) => h.kind === "negation" && h.count === 2 && h.budget === 1));

  // 3. Single-sentence 3-item enumeration even inside a long report (M=3 > 2)
  const filler = Array.from({ length: 8 }, (_, idx) => `第 ${idx + 1} 步已完成校验并记录指标。`).join("");
  const enumInLong = auditText(`${filler}本次仅调整入口参数：没改A、没动B、未开启C。`, config, rules);
  assert.ok(enumInLong.some((h) => h.kind === "negation" && h.rule === "单句否定堆叠" && h.count === 3));

  const buEnum = auditText("不改配置、不动数据库、也不开启灰度开关。", config, rules);
  assert.ok(buEnum.some((h) => h.kind === "negation" && h.rule === "单句否定堆叠" && h.count === 3));

  // 4. Long 12-sentence report with 3 scattered ordinary negations passes (budget=4)
  const longCleanReport = [
    "已完成日志聚合模块重构并通过集成回归。",
    "采样器默认窗口收敛为 30 秒。",
    "冷启动阶段缓存尚未预热，首包走磁盘回源。",
    "压缩器切换到流式写入模式。",
    "历史归档目录保持只读挂载。",
    "压测期间内存曲线没有出现抖动。",
    "指标上报格式与现有看板完全对齐。",
    "批处理队列吞吐提升至每秒 4200 条。",
    "异常重试退避上限固定为 8 秒。",
    "旧版迁移脚本不再随守护进程启动。",
    "所有改动保存在本地工作区。",
    "单测与仓库自检全部通过。",
  ].join("");
  assert.deepEqual(auditText(longCleanReport, config, rules), []);

  // 5. Cross-sentence repeated unperformed-action disclaimers caught even in a long report
  const repeatedDisclaimers = [
    ...Array.from({ length: 8 }, (_, idx) => `模块 ${idx + 1} 已完成静态检查。`),
    "核心补丁已落盘，尚未提交。",
    "远端分支保持原状，未推送。",
  ].join("");
  const disclaimerHits = auditText(repeatedDisclaimers, config, rules);
  assert.ok(
    disclaimerHits.some((h) => h.kind === "regex" && h.rule.includes("提交|推送")),
    `Expected repeated disclaimer regex hit, got: ${JSON.stringify(disclaimerHits)}`,
  );
});

test("plain-check deduplicates overlapping spans, exempts lexicalized words and mò compounds, and excludes headings from budget", () => {
  const { config } = loadConfig(CANON_TOML);
  const rules = compileRules(config);

  // Overlapping '，不再' / '尚未' / '没有' count once, so a single-clause reply passes (budget=1)
  assert.deepEqual(auditText("轮询开关已固定，不再自动重试。", config, rules), []);
  assert.deepEqual(auditText("远端凭据尚未注入，请先导入环境变量。", config, rules), []);

  // Lexicalized negation_allow words, technical compounds, and mò ('吞没'/'淹没'/'沉没') pass
  assert.deepEqual(
    auditText("未来规划让不同模块不断演进，不过不仅延迟不错，而且不但稳定、不止支持单机。", config, rules),
    [],
  );
  assert.deepEqual(
    auditText("当前接口与旧版协议不兼容，返回码不一致，输入队列非空。", config, rules),
    [],
  );
  assert.deepEqual(
    auditText("底层异常被吞没，关键告警被淹没，旧脚本属于沉没成本。", config, rules),
    [],
  );

  // Body blockquotes and vscode:// URI links are masked
  assert.deepEqual(
    auditText(
      "> 历史记录：这不是配置错误，而是接口超时，未提交、未推送、没有验证。\n\n详见 [未命名说明.md](vscode://vscode-remote/wsl+openSUSE-Leap-16.1/tmp/未提交/notes.md:1)，工作区修复已完成。",
      config,
      rules,
    ),
    [],
  );

  // Line-aware splitting strips ordered-list prefixes without splitting '1.' or 'v1.5.2' and flags headings
  const typed = splitTypedSentences("## 1. 检查摘要\n1. 完成 v1.5.2 语法校验。\n2. 更新守护脚本。");
  assert.deepEqual(typed, [
    { text: "1. 检查摘要", isHeading: true },
    { text: "完成 v1.5.2 语法校验", isHeading: false },
    { text: "更新守护脚本", isHeading: false },
  ]);

  // Headings cannot inflate prose sentence count S to bypass negation density
  const headingPadded = "## 一\n## 二\n## 三\n## 四\n## 五\n第一项未落盘。\n第二项没有生效。";
  const paddedHits = auditText(headingPadded, config, rules);
  assert.ok(paddedHits.some((h) => h.kind === "negation" && h.budget === 1 && h.count === 2));
});

test("plain-check runtime bypasses only PI_SUBAGENT_CHILD, preserves headless feedback, withdraws TUI retry drafts, and retains the last reply at the limit", async () => {
  const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "plain-runtime-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevSubagentChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_CODING_AGENT_DIR = tmpAgent;
  delete process.env.PI_SUBAGENT_CHILD;

  try {
    fs.copyFileSync(CANON_TOML, path.join(tmpAgent, "plain-check.toml"));
    const handlers = new Map<string, (...args: any[]) => any>();
    let transformer: ((md: string, ctx: any) => string) | undefined;
    const sentMessages: any[] = [];

    const fakePi = {
      on(event: string, fn: (...args: any[]) => any) {
        handlers.set(event, fn);
      },
      registerCommand() {},
      registerMarkdownTransformer(fn: (md: string, ctx: any) => string) {
        transformer = fn;
      },
      sendMessage(msg: any) {
        sentMessages.push(msg);
      },
    };

    registerPlainCheck(fakePi as unknown as Parameters<typeof registerPlainCheck>[0]);

    let statusValue: string | undefined = "initial";
    const makeCtx = (mode: string) => ({
      mode,
      hasUI: true,
      ui: {
        notify() {},
        setWidget(_key: string, factory: any) {
          factory?.({ invalidate() {}, requestRender() {} });
        },
        setStatus(_key: string, text: string | undefined) {
          statusValue = text;
        },
      },
    });

    await handlers.get("session_start")?.({}, makeCtx("tui"));
    assert.match(statusValue ?? "", /^plain-check: \d+ 条$/);

    // 1. Background subagent child (PI_SUBAGENT_CHILD=1) is bypassed completely
    process.env.PI_SUBAGENT_CHILD = "1";
    const subagentRes = await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "这不是重构，而是小修，未提交、未推送。" }],
        },
      },
      makeCtx("rpc"),
    );
    assert.equal(subagentRes, undefined);
    assert.equal(sentMessages.length, 0);
    delete process.env.PI_SUBAGENT_CHILD;

    // 2. Top-level non-TUI ('rpc' / headless) audits and forwards <previous_draft>
    const rpcDraft = "已完成提交 abc1234。需要我顺手 push 到远端吗？";
    const rpcRes = await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: rpcDraft }],
        },
      },
      makeCtx("rpc"),
    );
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].content, /<previous_draft>[\s\S]*abc1234[\s\S]*<\/previous_draft>/);
    assert.match(rpcRes.message.content[0].text, /^<!-- plain-check:retry:[\w-]+ -->/);
    assert.doesNotMatch(rpcRes.message.content[0].text, /abc1234/);

    // Reset turn state via new user input
    handlers.get("input")?.({ source: "user" });
    sentMessages.length = 0;

    // 3. Clean TUI reply clears the status bar slot instead of leaving 'plain-check: ok'
    const cleanRes = await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "已完成配置更新，改动保存在本地工作区。" }],
        },
      },
      makeCtx("tui"),
    );
    assert.equal(cleanRes, undefined);
    assert.equal(statusValue, undefined);

    // 4. Negation-only hit in TUI retries once (1/1), withdraws the draft, and preserves the last draft at the limit
    const retryRes = await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "第一版草稿：未提交、未推送。" }],
        },
      },
      makeCtx("tui"),
    );
    assert.equal(sentMessages.length, 1);
    assert.doesNotMatch(sentMessages[0].content, /<previous_draft>/);
    assert.match(statusValue ?? "", /\(1\/1\)/);
    const retryMarkedText = retryRes.message.content[0].text;
    assert.match(retryMarkedText, /^<!-- plain-check:retry:[\w-]+ -->/);
    const pendingDisplay = transformer!(retryMarkedText, { messageType: "assistant" });
    assert.match(pendingDisplay, /正在原位改写/);
    assert.doesNotMatch(pendingDisplay, /第一版草稿/);

    // During pendingRewrite, context keeps attempt 1 + feedback
    const ctxDuringRetry = await handlers.get("context")?.({
      messages: [
        { role: "user", content: [{ type: "text", text: "改一下配置" }] },
        retryRes.message,
        { role: "custom", customType: "plain-check-rewrite", content: sentMessages[0].content },
      ],
    });
    assert.equal(ctxDuringRetry.messages.length, 3);
    assert.equal(ctxDuringRetry.messages[1].content[0].text, "第一版草稿：未提交、未推送。");

    // Second negation hit reaches negation_max_retries=1 -> stops without firing another turn and keeps draft visible
    const stopRes = await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "第二版正文结论：配置没动。缓存没有清。" }],
        },
      },
      makeCtx("tui"),
    );
    assert.equal(sentMessages.length, 1);
    assert.match(statusValue ?? "", /保留原回复/);
    const stopMarkedText = stopRes.message.content[0].text;
    assert.match(stopMarkedText, /^<!-- plain-check:stop -->/);
    const renderedStop = transformer!(stopMarkedText, { messageType: "assistant" });
    assert.match(renderedStop, /原回复保留/);
    assert.match(renderedStop, /第二版正文结论：配置没动。缓存没有清。/);
    assert.equal(transformer!(retryMarkedText, { messageType: "assistant" }), "");

    // Context hook prunes superseded attempt 1 and feedback, leaving clean [user, attempt 2]
    const ctxAfterStop = await handlers.get("context")?.({
      messages: [
        { role: "user", content: [{ type: "text", text: "改一下配置" }] },
        retryRes.message,
        { role: "custom", customType: "plain-check-rewrite", content: sentMessages[0].content },
        stopRes.message,
      ],
    });
    assert.equal(ctxAfterStop.messages.length, 2);
    assert.equal(ctxAfterStop.messages[0].role, "user");
    assert.equal(ctxAfterStop.messages[1].content[0].text, "第二版正文结论：配置没动。缓存没有清。");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prevSubagentChild;
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
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

test("pi-steward serializes cache critical section and reports accurate /hub-status direction when hub lags or diverges", async () => {
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
    assert.match(laggingHubStatus.text, /工作仓落后远端 2 个提交（请手动 git pull --ff-only）/);
    assert.doesNotMatch(laggingHubStatus.text, /包缓存/);

    const divergedStatus = formatHubStatusText(diff, tmpAgent, {
      dirtyCount: 0,
      aheadCount: 2,
      behindCount: 1,
      cacheMismatch: false,
    });
    assert.match(divergedStatus.text, /已分叉.*领先 2、落后 1.*git pull --rebase/);
    assert.doesNotMatch(divergedStatus.text, /--ff-only/);
  } finally {
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
});

test("pi-steward maps self-package to hubRepoPath in-place on writable clones, configures branch.master.rebase, and restores git source on read-only nodes", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-single-source-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const hubRepo = path.join(tmpRoot, "hub");
    const cacheRepo = path.join(tmpRoot, "cache");
    const agentDir = path.join(tmpRoot, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    for (const dir of [hubRepo, cacheRepo]) {
      execFileSync("git", ["init", "-q", dir]);
      fs.mkdirSync(path.join(dir, "canon"), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, "canon", "settings.canon.json"), path.join(dir, "canon", "settings.canon.json"));
      fs.copyFileSync(path.join(REPO_ROOT, "canon", "AGENTS.md"), path.join(dir, "canon", "AGENTS.md"));
      fs.copyFileSync(path.join(REPO_ROOT, "canon", "plain-check.toml"), path.join(dir, "canon", "plain-check.toml"));
    }

    // Seed pre-existing local settings with remote self-package + extra local incubating package
    const extraLocalPkg = path.join(tmpRoot, "my-local-ext");
    fs.mkdirSync(extraLocalPkg, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify(
        {
          packages: ["git:github.com/nzh10/nzh10-skills", "npm:pi-subagents", extraLocalPkg],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const fakePi = {
      on() {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, spec.handler);
      },
    };
    registerPiSteward(fakePi as unknown as Parameters<typeof registerPiSteward>[0]);

    await commands.get("hub-init")?.(`dev-box ${hubRepo}`, {
      hasUI: true,
      ui: { notify() {} },
    });

    // 1. /hub-init enables both core.hooksPath=.githooks and branch.master.rebase=true
    assert.equal(execFileSync("git", ["-C", hubRepo, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(), ".githooks");
    assert.equal(execFileSync("git", ["-C", hubRepo, "config", "--get", "branch.master.rebase"], { encoding: "utf8" }).trim(), "true");

    // 2. settings.json replaces git:github.com/nzh10/nzh10-skills in-place with hubRepo (no duplicate, not in incubating)
    const syncedSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(syncedSettings.packages[0], hubRepo);
    assert.ok(!syncedSettings.packages.includes("git:github.com/nzh10/nzh10-skills"));
    assert.ok(syncedSettings.packages.includes(extraLocalPkg));

    // 3. Second computeStewardDiff is idempotent and excludes hubRepo from incubatingPackages
    const secondDiff = computeStewardDiff(hubRepo, agentDir);
    assert.equal(secondDiff.mode, "writable-clone");
    assert.equal(secondDiff.settingsChanged, false);
    assert.deepEqual(secondDiff.incubatingPackages, [extraLocalPkg]);

    // Writable /hub-status ahead of upstream never asks to push before /reload
    const aheadStatus = formatHubStatusText(secondDiff, agentDir, {
      dirtyCount: 0,
      aheadCount: 2,
      behindCount: 0,
      cacheMismatch: false,
      runtimeSourceMismatch: false,
    });
    assert.match(aheadStatus.text, /有 2 个提交待 push/);
    assert.doesNotMatch(aheadStatus.text, /先 push 再执行 \/reload/);

    // 4. Demoting to read-only node removes stale local hubRepo path and restores git:github.com/nzh10/nzh10-skills
    fs.unlinkSync(path.join(agentDir, "machine.json"));
    const roDiff = computeStewardDiff(cacheRepo, agentDir);
    assert.equal(roDiff.mode, "read-only-sync");
    assert.equal(roDiff.settingsChanged, true);
    await applyStewardDiff(roDiff, agentDir);
    const roSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(roSettings.packages[0], "git:github.com/nzh10/nzh10-skills");
    assert.ok(!roSettings.packages.includes(hubRepo));
    assert.ok(roSettings.packages.includes(extraLocalPkg));
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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

test("steward-preflight.sh fails read-only with --ff-only when behind and --rebase when diverged without mutating dirty worktree", () => {
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
    execFileSync("git", ["-C", hubRepo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", hubRepo, "config", "user.email", "1+test@users.noreply.github.com"]);
    execFileSync("git", ["-C", hubRepo, "config", "core.hooksPath", ".githooks"]);
    fs.mkdirSync(path.join(hubRepo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(hubRepo, ".git", "info", "no-upload-personal"), "secret-token\n", "utf8");
    fs.writeFileSync(
      path.join(agentDir, "machine.json"),
      JSON.stringify({ machineId: "test-hub", hubRepoPath: hubRepo }),
      "utf8",
    );

    // 1. Pure behind: suggests pull --ff-only and leaves dirty worktree untouched
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
    }, /behind upstream.*pull --ff-only/);

    assert.equal(fs.readFileSync(path.join(hubRepo, "canon", "AGENTS.md"), "utf8"), "# local dirty edit\n");

    // 2. Diverged (ahead + behind): suggests pull --rebase while remaining read-only
    fs.writeFileSync(path.join(hubRepo, "local-note.txt"), "local commit\n", "utf8");
    execFileSync("git", ["-C", hubRepo, "add", "--", "local-note.txt"]);
    execFileSync("git", ["-C", hubRepo, "commit", "-q", "-m", "feat: local commit on master"]);

    assert.throws(() => {
      execFileSync("sh", [preflightScript], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: "pipe",
      });
    }, /diverged from upstream \(1 ahead, 1 behind\).*pull --rebase/);

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

test("Pi/Node pre-commit checks validate staged syntax, settings and extension entry points", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-check-test-"));
  const script = path.join(REPO_ROOT, "scripts", "check-pi-node.mjs");
  const git = (...args: string[]) => execFileSync("git", ["-C", tmp, ...args], { stdio: "pipe" });
  const check = () => execFileSync(process.execPath, [script, tmp, "--index"], { encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q");
    for (const file of ["canon/settings.canon.json", "canon/plain-check.toml", "extensions/plain-check.ts", "extensions/wsl-links.ts", "extensions/pi-steward.ts"]) {
      const dest = path.join(tmp, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, file), dest);
    }
    git("add", "--", "canon", "extensions");
    assert.match(check(), /Pi\/Node checks passed \(index\)/);

    const syntax = path.join(tmp, "syntax.ts");
    fs.writeFileSync(syntax, 'import type { Missing } from "fixture";\nconst broken: number = ;\n');
    git("add", "--", "syntax.ts");
    fs.writeFileSync(syntax, 'const fixed: number = 1;\n');
    assert.throws(check, /syntax\.ts|Unexpected token/);
    git("add", "--", "syntax.ts");

    const settings = path.join(tmp, "canon/settings.canon.json");
    fs.writeFileSync(settings, '{"enabledModels":42}\n');
    git("add", "--", "canon/settings.canon.json");
    fs.copyFileSync(path.join(REPO_ROOT, "canon/settings.canon.json"), settings);
    assert.throws(check, /Pi enabledModels must be a string array/);
    git("add", "--", "canon/settings.canon.json");

    const entry = path.join(tmp, "extensions/wsl-links.ts");
    fs.writeFileSync(entry, 'export default 42;\n');
    git("add", "--", "extensions/wsl-links.ts");
    fs.copyFileSync(path.join(REPO_ROOT, "extensions/wsl-links.ts"), entry);
    assert.throws(check, /requires a default registration function/);
    git("add", "--", "extensions/wsl-links.ts");
    assert.match(check(), /Pi\/Node checks passed \(index\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function createModelSyncFixture(canonModels: string[]) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-models-"));
  const repoDir = path.join(tmpRoot, "repo");
  const agentDir = path.join(tmpRoot, "agent");
  fs.mkdirSync(path.join(repoDir, "canon"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const writeCanon = (models: string[]) => {
    fs.writeFileSync(
      path.join(repoDir, "canon", "settings.canon.json"),
      JSON.stringify({ enabledModels: models }, null, 2) + "\n",
      "utf8",
    );
  };
  writeCanon(canonModels);
  return { tmpRoot, repoDir, agentDir, writeCanon };
}

function makeFakeRegistry(registered: Record<string, boolean>) {
  return {
    getProvider(provider: string) {
      return Object.prototype.hasOwnProperty.call(registered, provider) ? { id: provider } : undefined;
    },
    getProviderAuthStatus(provider: string) {
      return { configured: Boolean(registered[provider]) };
    },
  };
}

test("pi-steward enabledModels sync handles 0-provider fresh takeover, Option A first login, Ctrl+X, Ctrl+A, and local delete/reorder without churn", async () => {
  const fixture = createModelSyncFixture([
    "xai/grok-4.7",
    "kimi-coding/k3.1-pro",
    "antigravity-acp/gemini-4-carbon",
    "antigravity-acp/gemini-3.8-flash",
  ]);
  try {
    // 1. Fresh machine with 0 configured providers -> writes enabledModels: [] and seenVisibleCanon: []
    const zeroReg = makeFakeRegistry({ xai: false, "kimi-coding": false, "antigravity-acp": false });
    const d1 = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: zeroReg, syncModels: true });
    assert.equal(d1.settingsChanged, true);
    assert.equal(d1.enabledModelsChanged, true);
    assert.deepEqual(d1.mergedSettings.enabledModels, []);
    assert.deepEqual(d1.nextSyncState.seenVisibleCanon, []);
    assert.deepEqual(d1.missingAuthProviders, ["xai", "kimi-coding", "antigravity-acp"]);
    await applyStewardDiff(d1, fixture.agentDir);

    // Repeat sync with 0 providers -> idempotent (0 churn)
    const d1Repeat = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: zeroReg, syncModels: true });
    assert.equal(d1Repeat.settingsChanged, false);
    assert.equal(d1Repeat.syncStateChanged, false);

    // 2. Option A: first login to antigravity-acp while local is [] -> imports its Canon models
    const acpOnlyReg = makeFakeRegistry({ xai: false, "kimi-coding": false, "antigravity-acp": true });
    const d2 = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: acpOnlyReg, syncModels: true });
    assert.equal(d2.enabledModelsChanged, true);
    assert.deepEqual(d2.mergedSettings.enabledModels, [
      "antigravity-acp/gemini-4-carbon",
      "antigravity-acp/gemini-3.8-flash",
    ]);
    assert.deepEqual(d2.nextSyncState.seenVisibleCanon, [
      "antigravity-acp/gemini-4-carbon",
      "antigravity-acp/gemini-3.8-flash",
    ]);
    await applyStewardDiff(d2, fixture.agentDir);

    // 3. Local /scoped-models delete, reorder, and custom model addition remain untouched on repeat sync
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enabledModels: ["custom/local-only", "antigravity-acp/gemini-3.8-flash"] }, null, 2) + "\n",
      "utf8",
    );
    const d3 = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: acpOnlyReg, syncModels: true });
    assert.equal(d3.settingsChanged, false);
    assert.equal(d3.syncStateChanged, false);

    // 4. Ctrl+X (enabledModels: []): new Canon model for configured provider -> [M]; unconfigured provider -> stays []
    fs.writeFileSync(settingsPath, JSON.stringify({ enabledModels: [] }, null, 2) + "\n", "utf8");
    const d4Stable = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: acpOnlyReg, syncModels: true });
    assert.equal(d4Stable.settingsChanged, false);

    // Add unconfigured provider model -> stays []
    fixture.writeCanon([
      "xai/grok-4.7",
      "xai/grok-5",
      "kimi-coding/k3.1-pro",
      "antigravity-acp/gemini-4-carbon",
      "antigravity-acp/gemini-3.8-flash",
    ]);
    const d4Unconf = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: acpOnlyReg, syncModels: true });
    assert.equal(d4Unconf.settingsChanged, false);
    assert.deepEqual(d4Unconf.mergedSettings.enabledModels, []);

    // Add configured provider model -> becomes [M]
    fixture.writeCanon([
      "xai/grok-4.7",
      "xai/grok-5",
      "kimi-coding/k3.1-pro",
      "antigravity-acp/gemini-4-carbon",
      "antigravity-acp/gemini-3.8-flash",
      "antigravity-acp/gemini-4-argon",
    ]);
    const d4Conf = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: acpOnlyReg, syncModels: true });
    assert.equal(d4Conf.enabledModelsChanged, true);
    assert.deepEqual(d4Conf.mergedSettings.enabledModels, ["antigravity-acp/gemini-4-argon"]);
    await applyStewardDiff(d4Conf, fixture.agentDir);

    // 5. Ctrl+A (enabledModels key deleted -> undefined): stays unrestricted while advancing seenVisibleCanon
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + "\n", "utf8");
    const allReg = makeFakeRegistry({ xai: true, "kimi-coding": true, "antigravity-acp": true });
    const d5 = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: allReg, syncModels: true });
    assert.equal(d5.settingsChanged, false);
    assert.equal(d5.mergedSettings.enabledModels, undefined);
    assert.equal(d5.syncStateChanged, true);
    assert.ok(d5.nextSyncState.seenVisibleCanon?.includes("xai/grok-5"));
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test("pi-steward logout/re-login stays seamless, Canon deletion cleans local list, and unregistered providers stay unknown", async () => {
  const fixture = createModelSyncFixture([
    "xai/grok-4.7",
    "kimi-coding/k3.1-pro-highspeed",
    "kimi-coding/k3.1-pro",
    "unloaded-ext/future-model",
  ]);
  try {
    // Unknown provider: getProvider returns undefined even though getProviderAuthStatus returns configured: false
    const regBoth = makeFakeRegistry({ xai: true, "kimi-coding": true });
    const probe = createProviderVisibilityProbe(regBoth);
    assert.equal(probe?.("unloaded-ext"), "unknown");

    const dInit = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: regBoth, syncModels: true });
    assert.deepEqual(dInit.missingAuthProviders, []);
    assert.deepEqual(dInit.mergedSettings.enabledModels, [
      "xai/grok-4.7",
      "kimi-coding/k3.1-pro-highspeed",
      "kimi-coding/k3.1-pro",
    ]);
    await applyStewardDiff(dInit, fixture.agentDir);

    // User deletes kimi-coding/k3.1-pro locally and adds kimi-coding/custom
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enabledModels: ["kimi-coding/custom", "kimi-coding/k3.1-pro-highspeed", "xai/grok-4.7"] }, null, 2) + "\n",
      "utf8",
    );

    // Temporary logout of kimi-coding: neither local enabledModels nor seenVisibleCanon shrinks
    const regKimiOut = makeFakeRegistry({ xai: true, "kimi-coding": false });
    const dOut = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: regKimiOut, syncModels: true });
    assert.equal(dOut.settingsChanged, false);
    assert.equal(dOut.syncStateChanged, false);
    assert.deepEqual(dOut.nextSyncState.seenVisibleCanon, [
      "xai/grok-4.7",
      "kimi-coding/k3.1-pro-highspeed",
      "kimi-coding/k3.1-pro",
    ]);

    // While kimi-coding is logged out, Canon adds kimi-coding/k3.2-new and deletes xai/grok-4.7
    fixture.writeCanon([
      "kimi-coding/k3.1-pro-highspeed",
      "kimi-coding/k3.1-pro",
      "kimi-coding/k3.2-new",
      "unloaded-ext/future-model",
    ]);
    const dWhileOut = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: regKimiOut, syncModels: true });
    assert.deepEqual(dWhileOut.mergedSettings.enabledModels, ["kimi-coding/custom", "kimi-coding/k3.1-pro-highspeed"]);
    assert.ok(!dWhileOut.nextSyncState.seenVisibleCanon?.includes("kimi-coding/k3.2-new"));
    await applyStewardDiff(dWhileOut, fixture.agentDir);

    // Re-login kimi-coding: deleted k3.1-pro is NOT resurrected, custom & order stay intact, k3.2-new appends
    const dReIn = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: regBoth, syncModels: true });
    assert.deepEqual(dReIn.mergedSettings.enabledModels, [
      "kimi-coding/custom",
      "kimi-coding/k3.1-pro-highspeed",
      "kimi-coding/k3.2-new",
    ]);
    assert.deepEqual(dReIn.nextSyncState.seenVisibleCanon, [
      "kimi-coding/k3.1-pro-highspeed",
      "kimi-coding/k3.1-pro",
      "kimi-coding/k3.2-new",
    ]);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test("pi-steward migrates v1 lastSyncedCanonModels smoothly and /hub-init preserves v1 marker until migration succeeds", async () => {
  const fixture = createModelSyncFixture(["xai/grok-4.7", "xai/grok-new", "kimi-coding/k3.1-pro"]);
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    // Seed a v1 machine that ONLY has legacy lastSyncedCanonModels in machine.json (no state file yet)
    execFileSync("git", ["init", "-q", fixture.repoDir]);
    fs.writeFileSync(
      path.join(fixture.agentDir, "machine.json"),
      JSON.stringify(
        {
          machineId: "old-box",
          lastSyncedCanonModels: ["xai/grok-4.7", "kimi-coding/k3.1-pro", "xai/retired-model"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    // User previously deleted xai/grok-4.7 locally, still had retired-model and custom/local
    fs.writeFileSync(
      path.join(fixture.agentDir, "settings.json"),
      JSON.stringify({ enabledModels: ["custom/local", "xai/retired-model"] }, null, 2) + "\n",
      "utf8",
    );

    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const fakePi = {
      on() {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, spec.handler);
      },
    };
    registerPiSteward(fakePi as unknown as Parameters<typeof registerPiSteward>[0]);

    const xaiOnlyReg = makeFakeRegistry({ xai: true, "kimi-coding": false });
    await commands.get("hub-init")?.(`old-box ${fixture.repoDir}`, {
      mode: "tui",
      hasUI: true,
      modelRegistry: xaiOnlyReg,
      ui: { notify() {} },
    });

    const settings = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8"));
    // retired-model removed, previously-deleted xai/grok-4.7 NOT resurrected, new xai/grok-new added, unconfigured kimi not added
    assert.deepEqual(settings.enabledModels, ["custom/local", "xai/grok-new"]);

    const state = readSyncState(fixture.agentDir);
    assert.deepEqual(state.seenVisibleCanon, ["xai/grok-4.7", "xai/grok-new"]);
    assert.equal(state.lastSyncedCanonModels, undefined);

    const markerAfter = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "machine.json"), "utf8"));
    assert.equal(markerAfter.lastSyncedCanonModels, undefined);

    // Later login to kimi-coding imports kimi-coding/k3.1-pro because v1 migration intersected with V
    const bothReg = makeFakeRegistry({ xai: true, "kimi-coding": true });
    const dLater = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: bothReg, syncModels: true });
    assert.deepEqual(dLater.mergedSettings.enabledModels, ["custom/local", "xai/grok-new", "kimi-coding/k3.1-pro"]);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test("pi-steward blocks model sync and login guide in headless/print/rpc modes, shows TUI login guide once, and reports missing providers in /hub-status", async () => {
  const fixture = createModelSyncFixture(["xai/grok-4.7", "kimi-coding/k3.1-pro"]);
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevOffline = process.env.PI_OFFLINE;
  try {
    execFileSync("git", ["init", "-q", fixture.repoDir]);
    fs.writeFileSync(
      path.join(fixture.agentDir, "machine.json"),
      JSON.stringify({ machineId: "tui-box", hubRepoPath: fixture.repoDir }, null, 2) + "\n",
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    process.env.PI_OFFLINE = "1";

    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const fakePi = {
      on(event: string, fn: (...args: any[]) => Promise<void>) {
        handlers.set(event, fn);
      },
      registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, spec.handler);
      },
    };
    registerPiSteward(fakePi as unknown as Parameters<typeof registerPiSteward>[0]);

    const xaiOnlyReg = makeFakeRegistry({ xai: true, "kimi-coding": false });
    const notices: string[] = [];

    // 1. Subagent / print mode must NOT write enabledModels, seenVisibleCanon, or loginGuideShown
    await handlers.get("session_start")?.(
      { reason: "startup" },
      { mode: "print", hasUI: false, modelRegistry: xaiOnlyReg, ui: { notify(m: string) { notices.push(m); } } },
    );
    const settingsAfterPrint = fs.existsSync(path.join(fixture.agentDir, "settings.json"))
      ? JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8"))
      : {};
    assert.equal(settingsAfterPrint.enabledModels, undefined);
    const stateAfterPrint = readSyncState(fixture.agentDir);
    assert.equal(stateAfterPrint.seenVisibleCanon, undefined);
    assert.equal(stateAfterPrint.loginGuideShown, undefined);

    // 2. First TUI start syncs enabledModels and shows one-time login guide for kimi-coding
    notices.length = 0;
    await handlers.get("session_start")?.(
      { reason: "startup" },
      { mode: "tui", hasUI: true, modelRegistry: xaiOnlyReg, ui: { notify(m: string) { notices.push(m); }, setStatus() {} } },
    );
    const settingsAfterTui = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settingsAfterTui.enabledModels, ["xai/grok-4.7"]);
    assert.equal(readSyncState(fixture.agentDir).loginGuideShown, true);
    assert.ok(notices.some((m) => m.includes("尚未登录的厂商（kimi-coding）") && m.includes("/reload") && m.includes("/new")));

    // 3. Second TUI start does NOT repeat login guide toast
    notices.length = 0;
    await handlers.get("session_start")?.(
      { reason: "startup" },
      { mode: "tui", hasUI: true, modelRegistry: xaiOnlyReg, ui: { notify(m: string) { notices.push(m); }, setStatus() {} } },
    );
    assert.ok(!notices.some((m) => m.includes("尚未登录的厂商")));

    // 4. /hub-status still displays missing providers read-only
    notices.length = 0;
    await commands.get("hub-status")?.("", {
      mode: "tui",
      hasUI: true,
      modelRegistry: xaiOnlyReg,
      ui: { notify(m: string) { notices.push(m); } },
    });
    assert.ok(notices.some((m) => m.includes("缺登厂商：kimi-coding")));
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test("pi-steward mergeCanonModelsForPromote isolates unconfigured providers and is zero-diff on re-run", () => {
  const canon = [
    "xai/grok-4.7",
    "kimi-coding/k3.1-pro-highspeed",
    "antigravity-acp/gemini-4-carbon",
    "kimi-coding/k3.1-pro",
    "antigravity-acp/gemini-4-argon",
  ];
  const reg = makeFakeRegistry({ xai: true, "kimi-coding": true, "antigravity-acp": false, openai: true });

  // Explicit mode: add/remove configured providers, reject unconfigured/unknown
  const exp1 = mergeCanonModelsForPromote(canon, {
    mode: "explicit",
    remove: ["xai/grok-4.7"],
    add: ["xai/grok-5", "kimi-coding/k3.1-pro"],
    modelRegistry: reg,
  });
  assert.deepEqual(exp1, [
    "kimi-coding/k3.1-pro-highspeed",
    "antigravity-acp/gemini-4-carbon",
    "kimi-coding/k3.1-pro",
    "antigravity-acp/gemini-4-argon",
    "xai/grok-5",
  ]);
  // Re-run produces zero diff
  const exp2 = mergeCanonModelsForPromote(exp1, {
    mode: "explicit",
    remove: ["xai/grok-4.7"],
    add: ["xai/grok-5", "kimi-coding/k3.1-pro"],
    modelRegistry: reg,
  });
  assert.deepEqual(exp2, exp1);

  assert.throws(
    () =>
      mergeCanonModelsForPromote(canon, {
        mode: "explicit",
        remove: ["antigravity-acp/gemini-4-carbon"],
        modelRegistry: reg,
      }),
    /unconfigured provider "antigravity-acp"/,
  );
  assert.throws(
    () =>
      mergeCanonModelsForPromote(canon, {
        mode: "explicit",
        add: ["unknown-vendor/m1"],
        modelRegistry: reg,
      }),
    /unknown provider "unknown-vendor"/,
  );

  // Align-providers mode: rejects [] and undefined; rejects unconfigured targets
  assert.throws(
    () =>
      mergeCanonModelsForPromote(canon, {
        mode: "align-providers",
        localModels: [],
        targetProviders: ["kimi-coding"],
        modelRegistry: reg,
      }),
    /non-empty/,
  );
  assert.throws(
    () =>
      mergeCanonModelsForPromote(canon, {
        mode: "align-providers",
        localModels: undefined,
        targetProviders: ["kimi-coding"],
        modelRegistry: reg,
      }),
    /non-empty/,
  );
  assert.throws(
    () =>
      mergeCanonModelsForPromote(canon, {
        mode: "align-providers",
        localModels: ["antigravity-acp/gemini-4-carbon"],
        targetProviders: ["antigravity-acp"],
        modelRegistry: reg,
      }),
    /unconfigured provider "antigravity-acp"/,
  );

  // Align-providers replaces slots in-place, flushes overflow after last slot, appends new provider, freezes others
  const localModels = [
    "kimi-coding/k3.1-pro",
    "kimi-coding/k3.2-turbo",
    "kimi-coding/k3.2-lite",
    "openai/gpt-5",
  ];
  const aligned1 = mergeCanonModelsForPromote(canon, {
    mode: "align-providers",
    localModels,
    targetProviders: ["kimi-coding", "openai"],
    modelRegistry: reg,
  });
  assert.deepEqual(aligned1, [
    "xai/grok-4.7",
    "kimi-coding/k3.1-pro",
    "antigravity-acp/gemini-4-carbon",
    "kimi-coding/k3.2-turbo",
    "kimi-coding/k3.2-lite",
    "antigravity-acp/gemini-4-argon",
    "openai/gpt-5",
  ]);
  // Re-run produces zero diff
  const aligned2 = mergeCanonModelsForPromote(aligned1, {
    mode: "align-providers",
    localModels,
    targetProviders: ["kimi-coding", "openai"],
    modelRegistry: reg,
  });
  assert.deepEqual(aligned2, aligned1);
});

test("pi-steward applyStewardDiff merges managed keys inside lock, aborts on enabledModels conflict, and never falls back on lock failure", async () => {
  const fixture = createModelSyncFixture(["xai/grok-4.7"]);
  try {
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    const statePath = path.join(fixture.agentDir, ".pi-steward-state.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ modelThinkingLevels: { "xai/grok-4.7": "medium" }, enabledModels: [] }, null, 2) + "\n",
      "utf8",
    );

    const reg = makeFakeRegistry({ xai: true });
    const diff = computeStewardDiff(fixture.repoDir, fixture.agentDir, { modelRegistry: reg, syncModels: true });
    assert.equal(diff.enabledModelsChanged, true);

    // 1. Lock failure must NOT fall back to writing settings.json or advancing state
    const failingLock = {
      withLock() {
        throw new Error("lock busy");
      },
    };
    const failRes = await applyStewardDiff(diff, fixture.agentDir, { settingsStorage: failingLock });
    assert.equal(failRes.applied, false);
    assert.match(failRes.lockError ?? "", /lock busy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).enabledModels, []);
    assert.equal(fs.existsSync(statePath), false);

    // 2. Concurrent enabledModels edit detected inside lock -> returns undefined, skips write and state advance
    let conflictWritten = false;
    const conflictLock = {
      withLock(_scope: "global", fn: (current: string | undefined) => string | undefined) {
        const concurrentDisk = JSON.stringify({
          modelThinkingLevels: { "xai/grok-4.7": "high" },
          enabledModels: ["user/just-added"],
        });
        const next = fn(concurrentDisk);
        if (next !== undefined) conflictWritten = true;
      },
    };
    const conflictRes = await applyStewardDiff(diff, fixture.agentDir, { settingsStorage: conflictLock });
    assert.equal(conflictRes.applied, false);
    assert.equal(conflictRes.conflict, true);
    assert.equal(conflictWritten, false);
    assert.equal(fs.existsSync(statePath), false);

    // 3. Concurrent unmanaged key update (modelThinkingLevels/theme) inside lock is preserved
    let savedJson = "";
    const preservingLock = {
      withLock(_scope: "global", fn: (current: string | undefined) => string | undefined) {
        const concurrentDisk = JSON.stringify({
          modelThinkingLevels: { "xai/grok-4.7": "high" },
          theme: "dark-pro",
          enabledModels: [],
        });
        const next = fn(concurrentDisk);
        assert.ok(next !== undefined);
        savedJson = next!;
        fs.writeFileSync(settingsPath, next!, "utf8");
      },
    };
    const okRes = await applyStewardDiff(diff, fixture.agentDir, { settingsStorage: preservingLock });
    assert.equal(okRes.applied, true);
    assert.equal(okRes.settingsWritten, true);
    const parsedSaved = JSON.parse(savedJson);
    assert.deepEqual(parsedSaved.modelThinkingLevels, { "xai/grok-4.7": "high" });
    assert.equal(parsedSaved.theme, "dark-pro");
    assert.deepEqual(parsedSaved.enabledModels, ["xai/grok-4.7"]);
    assert.deepEqual(readSyncState(fixture.agentDir).seenVisibleCanon, ["xai/grok-4.7"]);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test("agy-acp-official.cjs is desensitized, fixes official CCPA endpoint, resolves agy from PATH, and keeps syncLegacyAuthMarker guard", () => {
  const shimPath = path.join(REPO_ROOT, "scripts", "agy-acp-official.cjs");
  const st = fs.statSync(shimPath);
  assert.ok((st.mode & 0o111) !== 0, "scripts/agy-acp-official.cjs must be executable");

  const src = fs.readFileSync(shimPath, "utf8");
  assert.ok(src.startsWith("#!/usr/bin/env node\n"), "shebang must be preserved");
  assert.doesNotMatch(src, /AGY_ACP_CCPA_BASE_URL/);
  assert.doesNotMatch(src, /\/(?:home|Users)\/[A-Za-z0-9._-]+/);
  assert.match(src, /https:\/\/cloudcode-pa\.googleapis\.com/);
  assert.match(src, /function syncLegacyAuthMarker\(\)/);

  // Runtime check: resolves fake `agy` from PATH (no AGY_REAL_BIN, no ~/.local/bin/agy) and heals acp_token.json
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-shim-test-"));
  const fakeBinDir = path.join(tmpHome, "bin");
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAgy = path.join(fakeBinDir, "agy");
    fs.writeFileSync(fakeAgy, "#!/bin/sh\necho \"FAKE_AGY_ARGS:$*\"\n", { mode: 0o755 });

    const oauthTokenPath = path.join(tmpHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    fs.mkdirSync(path.dirname(oauthTokenPath), { recursive: true });
    fs.writeFileSync(oauthTokenPath, JSON.stringify({ token: { access_token: "dummy" } }) + "\n", "utf8");

    const env = { ...process.env, HOME: tmpHome, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` };
    delete env.AGY_REAL_BIN;
    delete env.GEMINI_HOME;
    delete env.ANTIGRAVITY_APP_DATA_DIR;

    const stdout = execFileSync(process.execPath, [shimPath, "--help"], { env, encoding: "utf8" });
    assert.match(stdout, /FAKE_AGY_ARGS:acp --dangerously-skip-permissions --help/);

    const legacyMarker = path.join(tmpHome, ".gemini", "antigravity-acp", "acp_token.json");
    assert.equal(fs.existsSync(legacyMarker), true);
    assert.match(fs.readFileSync(legacyMarker, "utf8"), /managed-by-antigravity-cli/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
