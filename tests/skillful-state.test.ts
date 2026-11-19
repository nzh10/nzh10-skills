import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { applyStewardDiff, computeStewardDiff, type SettingsStorageLike } from "../extensions/pi-steward.ts";

const id = "hub:skills/demo/SKILL.md";
const portableOther = "hub:skills/other/SKILL.md";
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillful-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const agent = path.join(root, "agent");
  const managed = path.join(repo, "packages/pi-skillful");
  const canon = path.join(repo, "canon/settings.canon.json");
  const settings = path.join(agent, "settings.json");
  const state = path.join(agent, ".pi-steward-state.json");
  const marker = path.join(agent, "machine.json");
  const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
  const write = (p: string, data: unknown) => fs.writeFileSync(p, JSON.stringify(data));
  for (const dir of [agent, path.dirname(canon), managed]) fs.mkdirSync(dir, { recursive: true });
  write(canon, { packages: [], skillful: { visibility: { [id]: "hide" } } });
  write(path.join(managed, "package.json"), { name: "pi-skillful" });
  fs.writeFileSync(path.join(managed, "index.ts"), "export default function() {}\n");
  const storage: SettingsStorageLike = { withLock(_scope, fn) {
    assert.equal(fn(fs.readFileSync(settings, "utf8")), undefined);
  } };
  const sync = (lock = storage) => applyStewardDiff(computeStewardDiff(repo, agent), agent, { settingsStorage: lock });
  return { repo, agent, managed, canon, settings, state, marker, read, write, sync };
}

test("opt-in deduplicates Skillful and updates only shared visibility defaults", async t => {
  const f = fixture(t);
  f.write(f.settings, { packages: [{ source: "npm:pi-skillful@0.5.2", skills: [] }, "npm:pi-skillful", "npm:other"],
    skillful: { hiddenSkills: [], visibility: { [id]: "show" }, preference: true } });
  assert.equal((await f.sync()).applied, true);
  const saved = f.read(f.settings);
  assert.deepEqual(saved.packages, [{ source: f.managed, skills: [] }, "npm:other"]);
  assert.deepEqual(saved.skillful, { hiddenSkills: [], visibility: { [id]: "show" }, preference: true, visibilityDefaults: { [id]: "hide" } });
  f.write(f.canon, { packages: [], skillful: { visibility: { [portableOther]: "show" } } });
  f.write(f.marker, { skillful: { enabled: false, autoCollect: true } });
  assert.equal((await f.sync()).applied, true);
  assert.deepEqual(f.read(f.settings).packages, ["npm:other"]);
  assert.deepEqual(f.read(f.settings).skillful, { ...saved.skillful, visibilityDefaults: { [portableOther]: "show" } });
  assert.equal(fs.existsSync(path.join(f.repo, "pools")), false);
});

test("cold start leaves Skillful off; missing managed copy or lost settings fails closed", async t => {
  const f = fixture(t);
  assert.equal((await f.sync()).applied, true);
  assert.equal(f.read(f.settings).skillful, undefined);
  f.write(f.settings, { packages: ["npm:pi-skillful"] });
  fs.unlinkSync(path.join(f.managed, "index.ts"));
  assert.throws(() => computeStewardDiff(f.repo, f.agent), /keeping the current source/);
  assert.deepEqual(f.read(f.settings).packages, ["npm:pi-skillful"]);
  fs.unlinkSync(f.settings);
  assert.throws(() => computeStewardDiff(f.repo, f.agent), /missing after takeover/);
  assert.equal(fs.existsSync(f.settings), false);
});

test("pending recovery changes only its managed field and preserves a concurrent menu save", async t => {
  const f = fixture(t);
  const oldDefaults = { [id]: "hide" }, nextDefaults = { [id]: "show" };
  const originalState = { seenVisibleCanon: ["known/model"], custom: true };
  const change = { key: "skillful.visibilityDefaults", before: { present: true, value: oldDefaults }, after: { present: true, value: nextDefaults } };
  const pending = { ...originalState, pendingSettings: { changes: [change], nextState: originalState } };
  f.write(f.canon, { packages: [], skillful: { visibility: nextDefaults } });
  f.write(f.state, pending);
  f.write(f.settings, { enabledModels: ["known/model"], skillful: { visibilityDefaults: oldDefaults } });
  const lock: SettingsStorageLike = { withLock(_scope, fn) {
    const now = f.read(f.settings);
    now.skillful.visibility = { [id]: "hide" };
    now.enabledModels.unshift("local/custom");
    f.write(f.settings, now);
    assert.equal(fn(fs.readFileSync(f.settings, "utf8")), undefined);
  } };
  const result = await f.sync(lock);
  assert.equal(result.applied, true);
  assert.deepEqual(f.read(f.settings).skillful, { visibilityDefaults: nextDefaults, visibility: { [id]: "hide" } });
  assert.deepEqual(f.read(f.settings).enabledModels, ["local/custom", "known/model"]);
  assert.equal(f.read(f.state).pendingSettings, undefined);
  assert.deepEqual(f.read(f.state).seenVisibleCanon, originalState.seenVisibleCanon);

  f.write(f.state, pending);
  const already = await f.sync();
  assert.equal(already.applied, true);
  assert.equal(already.settingsWritten, false);
  const divergent = f.read(f.settings);
  divergent.skillful.visibilityDefaults = {};
  f.write(f.settings, divergent);
  f.write(f.state, pending);
  assert.equal((await f.sync()).conflict, true);
  assert.deepEqual(f.read(f.settings), divergent);
  assert.deepEqual(f.read(f.state), pending);
});

test("the installed SDK holds its settings lock through atomic commit and releases it", {
  skip: !process.env.SKILLFUL_SDK_ROOT,
}, async t => {
  const f = fixture(t);
  f.write(f.settings, { skillful: { visibility: { [id]: "show" } } });
  f.write(f.marker, { skillful: { enabled: true } });
  const sdk = pathToFileURL(path.join(process.env.SKILLFUL_SDK_ROOT!, "dist/core/settings-manager.js")).href;
  const { SettingsManager } = await import(sdk);
  const storage = SettingsManager.create(f.agent, f.agent).storage as SettingsStorageLike;
  const lockPath = `${f.settings}.lock`;
  const checked: SettingsStorageLike = { withLock(scope, fn) {
    storage.withLock(scope, current => {
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(fn(current), undefined);
      assert.equal(fs.existsSync(lockPath), true);
      return undefined;
    });
  } };
  const result = await f.sync(checked);
  assert.equal(result.applied, true, result.lockError);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(f.read(f.settings).skillful, { visibility: { [id]: "show" }, visibilityDefaults: { [id]: "hide" } });
});
