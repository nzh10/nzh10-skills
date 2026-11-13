import assert from "node:assert/strict";
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

