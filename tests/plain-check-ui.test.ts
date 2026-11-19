import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import registerPlainCheck, { hiddenRetryKeys, stripMarkers, supersededRetries } from "../extensions/plain-check.ts";

const reply = (text: string, stopReason = "stop", extra: any[] = []) => ({
  role: "assistant", stopReason, content: [{ type: "text", text }, ...extra],
});
const textOf = (message: any) => message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const bad = "原始正文：BAD。完整数据 12345。";
const good = "新版正文：完成更新。完整数据 12345。";

// Mimic the documented order: message_end -> UI -> persistence -> turn_end.
// No provider calls, real credentials, or global config writes.
async function harness(maxRetries = 1, entries: any[] = [], renderer?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ui-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  fs.writeFileSync(path.join(dir, "plain-check.toml"), `enabled = true\nmax_retries = ${maxRetries}\nkeywords = ["BAD"]\nregex = []\n`);
  let hooks = new Map<string, any>();
  let commands = new Map<string, any>();
  let transform: any;
  let status: string | undefined;
  let sendFailure = false;
  let redrawFailure = false;
  let refreshCount = 0;
  const queued: any[] = [];
  const notices: any[] = [];
  let serial = entries.length;
  const branch = [...entries];
  const ctx: any = {
    mode: "tui", hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (...args: any[]) => notices.push(args),
      setStatus: (_key: string, value: string | undefined) => { status = value; },
      setWidget: (_key: string, factory: any) => factory?.({
        invalidate() { if (redrawFailure) throw new Error("render failure"); renderer?.invalidate(); },
        requestRender(force: boolean) { assert.equal(force, true); refreshCount++; renderer?.requestRender?.(force); },
      }),
    },
  };
  const api: any = {
    on: (event: string, fn: any) => hooks.set(event, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMarkdownTransformer: (fn: any) => { transform = fn; },
    sendMessage: (message: any) => {
      if (sendFailure) throw new Error("send failure");
      queued.push(message);
    },
  };
  const emit = (event: string, value: any = {}) => hooks.get(event)?.(value, ctx);
  const install = async () => {
    hooks = new Map(); commands = new Map();
    registerPlainCheck(api);
    await emit("session_start", { reason: "reload" });
  };
  await install();
  return {
    ctx, branch, queued, notices, emit,
    get status() { return status; },
    get refreshCount() { return refreshCount; },
    transform: (text: string, meta: any = {}) => transform(text, { messageType: "assistant", ...meta }),
    sendFailure: (value: boolean) => { sendFailure = value; },
    redrawFailure: (value: boolean) => { redrawFailure = value; },
    command: (arg: string) => commands.get("plain").handler(arg, ctx),
    async finish(message: any) {
      const result = await emit("message_end", { message });
      const final = result?.message ?? message;
      branch.push({ type: "message", id: `m${++serial}`, message: final });
      await emit("turn_end", { message: final });
      return final;
    },
    async deliverFeedback() {
      const message = queued.shift();
      assert.ok(message, "a rewrite must have been submitted");
      branch.push({ type: "custom_message", id: `f${++serial}`, ...message });
      await emit("message_end", { message: { role: "custom", ...message } });
      return message;
    },
    async reload() { await emit("session_shutdown", { reason: "reload" }); await install(); },
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      // Audit writes are best-effort async writes; let their callbacks finish.
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      for (const name of ["plain-check.toml", "plain-check.log.jsonl"]) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.rmdirSync(dir);
    },
  };
}

test("TUI withdraws only the final text, keeps a full recovery copy, and hides it after success and reload", async () => {
  const h = await harness();
  try {
    const thinking = { type: "thinking", thinking: "Independent thinking", thinkingSignature: "signature" };
    const original = reply(bad, "stop", [thinking, { type: "text", text: "末段证据。" }]);
    const marked = await h.finish(original);
    assert.match(h.transform(textOf(marked)), /正在原位改写/);
    assert.doesNotMatch(h.transform(textOf(marked)), /完整数据|末段证据/);
    assert.equal(stripMarkers(textOf(marked)), textOf(original));
    assert.deepEqual(marked.content[1], thinking);
    assert.equal(h.transform(thinking.thinking, { messageType: "assistant-thinking" }), thinking.thinking);
    const feedback = await h.deliverFeedback();
    assert.doesNotMatch(feedback.content, /<previous_draft>/);
    assert.ok(feedback.details.retryKey);
    const replacement = await h.finish(reply(good));
    assert.equal(h.transform(textOf(marked)), "");
    assert.equal(h.transform(textOf(replacement)), good);
    assert.equal(h.status, undefined);
    assert.ok(h.refreshCount > 0);
    const rawHistory = JSON.stringify(h.branch);
    await h.reload();
    assert.equal(h.transform(textOf(marked)), "");
    assert.equal(h.transform(textOf(replacement)), good);
    assert.equal(JSON.stringify(h.branch), rawHistory, "reload leaves raw session records intact");
  } finally { await h.close(); }
});

test("clean replies and ordinary tool turns do not force transcript redraws", async () => {
  const h = await harness();
  try {
    const before = h.refreshCount;
    await h.finish(reply(good));
    await h.finish(reply("Progress", "toolUse", [{ type: "toolCall", id: "t1", name: "read", arguments: {} }]));
    await h.emit("agent_settled");
    assert.equal(h.refreshCount, before);
  } finally { await h.close(); }
});

test("retry limit keeps the last complete draft and submits no extra rewrite", async () => {
  const h = await harness();
  try {
    const first = await h.finish(reply(bad));
    await h.deliverFeedback();
    const last = await h.finish(reply("最后完整正文：BAD。"));
    assert.equal(h.queued.length, 0);
    assert.equal(h.transform(textOf(first)), "");
    assert.match(h.transform(textOf(last)), /最后完整正文/);
    assert.match(h.transform(textOf(last)), /原回复保留/);
    await h.emit("agent_settled");
    await h.reload();
    assert.equal(h.transform(textOf(first)), "");
    assert.match(h.transform(textOf(last)), /最后完整正文/);
  } finally { await h.close(); }
});

test("zero retries preserves the first complete draft", async () => {
  const h = await harness(0);
  try {
    const marked = await h.finish(reply(bad));
    assert.equal(h.queued.length, 0);
    assert.match(h.transform(textOf(marked)), /原始正文/);
  } finally { await h.close(); }
});

for (const reason of ["aborted", "error", "length", "empty", "toolUse"]) {
  test(`${reason} during rewrite restores the last full draft, including after reload`, async () => {
    const h = await harness();
    try {
      const first = await h.finish(reply(bad));
      await h.deliverFeedback();
      const extra = reason === "toolUse" ? [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] : [];
      await h.finish(reply(reason === "empty" ? "" : "Partial output", reason === "empty" ? "stop" : reason, extra));
      await h.emit("agent_settled", { aborted: reason === "aborted" });
      assert.equal(h.transform(textOf(first)), bad);
      const messages = h.branch.map((e: any) => e.type === "message" ? e.message : { role: "custom", ...e });
      const context = await h.emit("context", { messages });
      assert.ok(context.messages.some((m: any) => m.role === "assistant" && textOf(m) === bad));
      await h.reload();
      assert.equal(h.transform(textOf(first)), bad);
    } finally { await h.close(); }
  });
}

test("repeated retries recover the newest complete draft on abort", async () => {
  const h = await harness(3);
  try {
    const first = await h.finish(reply(bad));
    await h.deliverFeedback();
    const second = await h.finish(reply("第二版完整正文：BAD。"));
    await h.deliverFeedback();
    await h.finish(reply("unfinished", "error"));
    await h.emit("agent_settled");
    assert.equal(h.transform(textOf(first)), "");
    assert.equal(h.transform(textOf(second)), "第二版完整正文：BAD。");
    await h.reload();
    assert.equal(h.transform(textOf(first)), "");
    assert.equal(h.transform(textOf(second)), "第二版完整正文：BAD。");
  } finally { await h.close(); }
});

test("submission failure keeps the original and does not consume the retry budget", async () => {
  const h = await harness();
  try {
    h.sendFailure(true);
    const first = await h.finish(reply(bad));
    assert.equal(textOf(first), bad);
    assert.equal(h.queued.length, 0);
    assert.match(h.status!, /提交失败/);
    h.sendFailure(false);
    const second = await h.finish(reply(bad));
    assert.match(h.transform(textOf(second)), /正在原位改写/);
    assert.equal(h.queued.length, 1);
  } finally { await h.close(); }
});

test("redraw failure restores content rather than leaving the draft withdrawn", async () => {
  const h = await harness();
  try {
    h.redrawFailure(true);
    const marked = await h.finish(reply(bad));
    assert.equal(h.transform(textOf(marked)), bad);
    h.redrawFailure(false);
    await h.emit("agent_settled");
    await h.reload();
    assert.equal(h.transform(textOf(marked)), bad);
  } finally { await h.close(); }
});

for (const boundary of ["reload", "input", "off", "config-reload", "tree"]) {
  test(`${boundary} while a rewrite is pending recovers the original`, async () => {
    const h = await harness();
    try {
      const marked = await h.finish(reply(bad));
      if (boundary === "reload") await h.reload();
      if (boundary === "input") await h.emit("input", { source: "interactive" });
      if (boundary === "off") await h.command("off");
      if (boundary === "config-reload") await h.command("reload");
      if (boundary === "tree") await h.emit("session_tree");
      assert.equal(h.transform(textOf(marked)), bad);
    } finally { await h.close(); }
  });
}

test("new user boundaries and unrelated feedback cannot supersede a draft", () => {
  const marked = reply("<!-- plain-check:retry:one -->\n" + bad);
  const feedback = { role: "custom", customType: "plain-check-rewrite", details: { retryKey: "one" } };
  assert.deepEqual([...supersededRetries([marked, reply(good)])], []);
  assert.deepEqual([...supersededRetries([marked, { ...feedback, details: { retryKey: "other" } }, reply(good)])], []);
  assert.deepEqual([...supersededRetries([marked, feedback, { role: "user", content: "New task" }, reply(good)])], []);
  assert.deepEqual([...supersededRetries([marked, feedback, reply("tool", "toolUse"), reply(good)])], [0]);
});

test("legacy markers use entry identity so identical drafts in separate turns stay distinct", async () => {
  const marked = reply("<!-- plain-check:retry -->\n" + bad);
  const entries = [
    { type: "message", id: "old", message: marked },
    { type: "custom_message", customType: "plain-check-rewrite", content: "Rewrite", display: false },
    { type: "message", id: "done", message: reply(good) },
    { type: "message", id: "user", message: { role: "user", content: "Another request" } },
    { type: "message", id: "interrupted", message: marked },
  ];
  assert.deepEqual([...hiddenRetryKeys(entries)], ["entry:old"]);
  const h = await harness(1, entries);
  try {
    assert.equal(h.transform(textOf(marked), { messageId: "old" }), "");
    assert.equal(h.transform(textOf(marked), { messageId: "interrupted" }), bad);
    h.branch.splice(1);
    await h.emit("session_tree");
    assert.equal(h.transform(textOf(marked), { messageId: "old" }), bad);
  } finally { await h.close(); }
});

test("over 64 old attempts stay withdrawn and other-extension marker prefixes are supported", async () => {
  const h = await harness(100);
  try {
    const drafts: any[] = [];
    for (let i = 0; i < 70; i++) {
      drafts.push(await h.finish(reply(`<!-- reply-review:other -->\nBAD draft ${i}`)));
      await h.deliverFeedback();
    }
    await h.finish(reply(good));
    await h.reload();
    for (const draft of drafts) assert.equal(h.transform(textOf(draft)), "");
  } finally { await h.close(); }
});

// Run with PI_TEST_HOST_ROOT pointing to the installed pi-coding-agent package.
// This uses Pi's real assistant/Markdown/Container components, not a fake text
// renderer, while keeping provider calls and the user's terminal out of the test.
test("installed Pi TUI components repaint withdrawal, replacement, recovery and resize", {
  skip: !process.env.PI_TEST_HOST_ROOT && "Set PI_TEST_HOST_ROOT to test the installed TUI",
}, async () => {
  const root = process.env.PI_TEST_HOST_ROOT!;
  const load = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);
  const { AssistantMessageComponent } = await load("dist/modes/interactive/components/assistant-message.js");
  const { initTheme, getMarkdownTheme } = await load("dist/modes/interactive/theme/theme.js");
  const { Container } = await load("../pi-tui/dist/tui.js");
  initTheme("dark", false);
  const chat = new Container();
  const h = await harness(1, [], chat);
  try {
    const transformers = [(text: string, meta: any) => h.transform(text, meta)];
    const make = (message: any, id?: string) => new AssistantMessageComponent(message, false, getMarkdownTheme(), "", 1, transformers, id);
    const original = reply(bad);
    const component = make(original);
    chat.addChild(component);
    assert.match(chat.render(100).join("\n"), /12345/);
    const marked = await h.finish(original);
    component.updateContent(marked, false);
    assert.match(chat.render(100).join("\n"), /原位改写/);
    assert.doesNotMatch(chat.render(100).join("\n"), /12345/);
    await h.emit("agent_settled", { aborted: true });
    assert.match(chat.render(100).join("\n"), /12345/);

    await h.emit("input", { source: "interactive" });
    const second = await h.finish(reply(bad));
    chat.clear(); chat.addChild(make(second));
    // The first interrupted feedback remains in the harness queue; discard it.
    h.queued.shift();
    await h.deliverFeedback();
    const replacement = await h.finish(reply(good));
    chat.addChild(make(replacement));
    for (const width of [24, 80, 120]) {
      chat.invalidate();
      const output = chat.render(width).join("\n");
      assert.doesNotMatch(output, /BAD|原位改写|plain-check:/);
      assert.equal((output.match(/12345/g) ?? []).length, 1);
    }
    await h.reload();
    chat.clear();
    for (const entry of h.branch.slice(-3)) {
      if (entry.type === "message") chat.addChild(make(entry.message, entry.id));
    }
    assert.equal((chat.render(120).join("\n").match(/12345/g) ?? []).length, 1);
  } finally { await h.close(); }
});

for (const [file, name] of [["tui-main-screen", "TuiMainScreen"], ["tui-alt-screen", "TuiAltScreen"]]) {
  test(`installed ${name} clears old terminal output on withdrawal and recovery`, {
    skip: !process.env.PI_TEST_HOST_ROOT && "Set PI_TEST_HOST_ROOT to test the installed TUI",
  }, async () => {
    const root = process.env.PI_TEST_HOST_ROOT!;
    const load = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);
    const { [name]: Renderer } = await load(`../pi-tui/dist/${file}.js`);
    const { AssistantMessageComponent } = await load("dist/modes/interactive/components/assistant-message.js");
    const { initTheme, getMarkdownTheme } = await load("dist/modes/interactive/theme/theme.js");
    initTheme("dark", false);
    const writes: string[] = [];
    const terminal = {
      columns: 80, rows: 24, kittyProtocolActive: false,
      start() {}, stop() {}, write: (data: string) => writes.push(data),
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const screen = new Renderer(terminal);
    const h = await harness(1, [], screen);
    try {
      const original = reply(bad);
      const component = new AssistantMessageComponent(original, false, getMarkdownTheme(), "", 1,
        [(text: string, meta: any) => h.transform(text, meta)]);
      screen.addChild(component);
      screen.start(); screen.renderNow();
      assert.match(writes.join(""), /12345/);
      writes.length = 0;
      const marked = await h.finish(original);
      component.updateContent(marked, false);
      await new Promise((resolve) => setImmediate(resolve));
      const withdrawn = writes.join("");
      assert.doesNotMatch(withdrawn, /12345/);
      assert.match(withdrawn, /原位改写/);
      if (name === "TuiMainScreen") assert.ok(withdrawn.includes("\x1b[3J"), "clear terminal scrollback too");
      writes.length = 0;
      await h.emit("agent_settled", { aborted: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(writes.join(""), /12345/);
    } finally { await h.close(); screen.stop(); }
  });
}
