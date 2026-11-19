import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync, statSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'skillful-package-')));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function loadConfig(dir) {
  const source = readFileSync(join(root, 'packages/pi-skillful/src/config.ts'), 'utf8')
    .replace('from "@earendil-works/pi-coding-agent"', 'from "./sdk.mjs"');
  writeFileSync(join(dir, 'config.mjs'), stripTypeScriptTypes(source));
  writeFileSync(join(dir, 'sdk.mjs'), `
    export const CONFIG_DIR_NAME = '.pi';
    export const getAgentDir = () => ${JSON.stringify(dir)};
    export const SettingsManager = { create(...args) { return globalThis.skillfulSDK(...args); } };
  `);
  return import(pathToFileURL(join(dir, 'config.mjs')).href);
}

test('global saves merge locked current, commit atomically under SDK lock, preserve unknown fields', async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ stale: true }));
    const inode = statSync(path).ino;
    let called = 0;
    globalThis.skillfulSDK = (cwd, agentDir, options) => {
      assert.equal(agentDir, dir);
      assert.equal(options.projectTrusted, false);
      return { storage: { withLock(scope, callback) {
        assert.equal(scope, 'global');
        // Simulate a steward update after initial loading but before the locked callback.
        const current = { packages: ['kept'], other: { x: 1 }, skillful: { custom: 4, hiddenSkills: ['latest'] } };
        writeFileSync(path, JSON.stringify(current));
        const result = callback(readFileSync(path, 'utf8'));
        assert.equal(result, undefined, 'SDK must not perform a later unlocked write');
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        assert.deepEqual(saved.packages, ['kept']);
        assert.deepEqual(saved.other, { x: 1 });
        assert.equal(saved.skillful.custom, 4);
        assert.deepEqual(saved.skillful.hiddenSkills, ['added', 'latest']);
        assert.notEqual(statSync(path).ino, inode, 'save must rename, not truncate');
        called++;
      } } };
    };
    await config.updateHiddenSkills('global', dir, names => [...names, 'added']);
    assert.equal(called, 1);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['other', 'packages', 'skillful']);
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('bad JSON, non-object, missing file, missing SDK lock and lock failure never overwrite global settings', async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir);
    const path = join(dir, 'settings.json');
    for (const raw of ['{broken', '[]', 'null']) {
      writeFileSync(path, raw);
      globalThis.skillfulSDK = () => ({ storage: { withLock(_scope, callback) { callback(readFileSync(path, 'utf8')); } } });
      await assert.rejects(config.writeHiddenSkills('global', dir, ['x']));
      assert.equal(readFileSync(path, 'utf8'), raw);
    }
    for (const manager of [{}, { storage: { withLock() { throw new Error('ELOCKED'); } } }]) {
      writeFileSync(path, '{}');
      globalThis.skillfulSDK = () => manager;
      await assert.rejects(config.writeHiddenSkills('global', dir, ['x']));
      assert.equal(readFileSync(path, 'utf8'), '{}');
    }
    rmSync(path);
    globalThis.skillfulSDK = () => { throw new Error('must not create SDK for absent file'); };
    await assert.rejects(config.writeHiddenSkills('global', dir, ['x']), /must exist/);
    assert.equal(existsSync(path), false);
    writeFileSync(path, '{}');
    globalThis.skillfulSDK = () => ({ storage: { withLock(_scope, callback) { rmSync(path); callback(undefined); } } });
    await assert.rejects(config.writeHiddenSkills('global', dir, ['x']), /disappeared/);
    assert.equal(existsSync(path), false);
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('global atomic save retains a settings symlink', { skip: process.platform === 'win32' }, async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir), target = join(dir, 'linked-settings.json'), path = join(dir, 'settings.json');
    writeFileSync(target, '{}', { mode: 0o600 }); symlinkSync(target, path);
    globalThis.skillfulSDK = () => ({ storage: { withLock(_scope, callback) { return callback(readFileSync(path, 'utf8')); } } });
    await config.writeHiddenSkills('global', dir, []);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).skillful.hiddenSkills, []);
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('project trust, inheritance, unknown fields and deletion semantics remain intact', async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir);
    const path = join(dir, '.pi/settings.json');
    await assert.rejects(config.writeHiddenSkills('project', dir, ['x']), /trusted/);
    assert.equal(existsSync(path), false);
    writeFileSync(join(dir, 'settings.json'), '{"skillful":{"hiddenSkills":["global"]}}');
    globalThis.skillfulSDK = () => ({ storage: { withLock(scope, callback) {
      assert.equal(scope, 'project');
      return callback(readFileSync(path, 'utf8'));
    } } });
    await config.writeProjectSkillfulOverride(dir, ['project'], { 1: 'one' }, true);
    assert.deepEqual([...await config.readEffectiveHiddenSkills(dir, true)], ['project']);
    assert.deepEqual([...await config.readEffectiveHiddenSkills(dir, false)], ['global']);
    await config.writeProjectSkillfulOverride(dir, undefined, undefined, true);
    assert.equal(existsSync(path), false);
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(path, '{"other":1,"skillful":{"custom":2,"visibleSkills":["old"]}}');
    await config.writeProjectSkillfulOverride(dir, undefined, undefined, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: 1, skillful: { custom: 2 } });
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('per-item writes retain explicit equality and legacy lists without freezing another layer', async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir);
    const globalPath = join(dir, 'settings.json'), projectPath = join(dir, '.pi/settings.json');
    writeFileSync(globalPath, JSON.stringify({ skillful: { visibilityDefaults: { 'hub:skills/a/SKILL.md': 'hide' }, custom: 1 } }));
    globalThis.skillfulSDK = (_cwd, _agentDir, options) => ({ storage: { withLock(scope, callback) {
      assert.equal(options.projectTrusted, scope === 'project');
      const path = scope === 'global' ? globalPath : projectPath;
      // Keep a concurrent unrelated item visible to the locked mutation.
      const current = JSON.parse(readFileSync(path, 'utf8'));
      current.skillful ??= {};
      current.skillful.visibility ??= {};
      current.skillful.visibility['hub:skills/concurrent/SKILL.md'] = 'show';
      writeFileSync(path, JSON.stringify(current));
      callback(readFileSync(path, 'utf8'));
    } } });
    const id = 'hub:skills/a/SKILL.md';
    await config.updateSkillVisibility('project', dir, id, 'a', 'hide', false, true);
    let project = JSON.parse(readFileSync(projectPath, 'utf8')).skillful;
    assert.deepEqual(project, { visibility: { [id]: 'hide', 'hub:skills/concurrent/SKILL.md': 'show' } });
    assert.equal(Object.hasOwn(project, 'toggleSlots'), false);
    assert.equal(Object.hasOwn(project, 'hiddenSkills'), false);
    await config.updateSkillVisibility('project', dir, id, 'a', 'inherit', false, true);
    project = JSON.parse(readFileSync(projectPath, 'utf8')).skillful;
    assert.equal(Object.hasOwn(project.visibility, id), false);
    writeFileSync(projectPath, JSON.stringify({ other: 9, skillful: { hiddenSkills: [], visibleSkills: ['old'], toggleSlots: { 3: 'slot' } } }));
    await config.updateSkillVisibility('project', dir, 'project:a/SKILL.md', 'a', 'inherit', true, true);
    project = JSON.parse(readFileSync(projectPath, 'utf8')).skillful;
    assert.equal(project.visibility['project:a/SKILL.md'], 'inherit', 'bypass legacy [] for this item only');
    assert.deepEqual(project.hiddenSkills, []);
    assert.deepEqual(project.visibleSkills, ['old']);
    assert.deepEqual(project.toggleSlots, { 3: 'slot' });
    await assert.rejects(config.updateSkillVisibility('project', dir, 'file:/outside', 'a', 'hide', true, true), /portable/);
    await config.updateSkillVisibility('global', dir, id, 'a', 'hide', false);
    const global = JSON.parse(readFileSync(globalPath, 'utf8')).skillful;
    assert.equal(global.visibility[id], 'hide', 'explicit same-as-canon remains explicit');
    assert.deepEqual(global.visibilityDefaults, { [id]: 'hide' });
    assert.equal(global.custom, 1);
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('clearing final Global visibility retains settings; empty Project symlink retains target', async () => {
  const dir = temporary();
  try {
    const config = await loadConfig(dir);
    const globalPath = join(dir, 'settings.json'), projectPath = join(dir, '.pi/settings.json');
    writeFileSync(globalPath, '{"skillful":{"visibility":{"hub:skills/a/SKILL.md":"hide"}}}');
    globalThis.skillfulSDK = () => ({ storage: { withLock(scope, callback) {
      return callback(readFileSync(scope === 'global' ? globalPath : projectPath, 'utf8'));
    } } });
    await config.updateSkillVisibility('global', dir, 'hub:skills/a/SKILL.md', 'a', 'inherit', false);
    assert.deepEqual(JSON.parse(readFileSync(globalPath, 'utf8')), {});
    if (process.platform !== 'win32') {
      mkdirSync(join(dir, '.pi'));
      const target = join(dir, 'project-target.json');
      writeFileSync(target, '{"skillful":{"visibility":{"project:a.md":"hide"}}}');
      symlinkSync(target, projectPath);
      await config.updateSkillVisibility('project', dir, 'project:a.md', 'a', 'inherit', false, true);
      assert.equal(lstatSync(projectPath).isSymbolicLink(), true);
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {});
    }
  } finally { delete globalThis.skillfulSDK; rmSync(dir, { recursive: true, force: true }); }
});

test('offline sync applies patch; conflict and failed replacement preserve old tree and metadata', () => {
  const dir = temporary();
  try {
    for (const sub of ['scripts', 'patches', 'upstreams', 'fixture/packages', 'bin']) mkdirSync(join(dir, sub), { recursive: true });
    cpSync(join(root, 'scripts/sync-pi-skillful.sh'), join(dir, 'scripts/sync-pi-skillful.sh'));
    cpSync(join(root, 'patches/pi-skillful.patch'), join(dir, 'patches/pi-skillful.patch'));
    cpSync(join(root, 'packages/pi-skillful'), join(dir, 'fixture/packages/pi-skillful'), { recursive: true });
    run('git', ['apply', '--reverse', join(dir, 'patches/pi-skillful.patch')], { cwd: join(dir, 'fixture') });
    writeFileSync(join(dir, 'fixture/packages/pi-skillful/SECURITY.md'), '# Upstream security policy\n');
    const git = run('which', ['git']).stdout.trim();
    // Only source acquisition is mocked; actual git apply and shell transaction run offline.
    writeFileSync(join(dir, 'bin/git'), `#!/bin/sh
if [ "$1" = -C ]; then
  source=$2; shift 2
  case "$1" in
    rev-parse) echo fixture-upstream; exit 0 ;;
    archive) output=$2; output=\${output#--output=}; tar -cf "$output" -C "$source" packages/pi-skillful; exit $? ;;
  esac
fi
exec ${JSON.stringify(git)} "$@"
`, { mode: 0o755 });
    const env = { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH };
    const args = [join(dir, 'scripts/sync-pi-skillful.sh'), '--source', join(dir, 'fixture')];
    run('sh', args, { env });
    assert.equal(existsSync(join(dir, 'packages/pi-skillful/SECURITY.md')), false);
    assert.match(readFileSync(join(dir, 'packages/pi-skillful/README.md'), 'utf8'), /https:\/\/github.com\/jvm\/pi-mono\/blob\/main\/packages\/pi-skillful\/SECURITY.md/);
    const configPath = join(dir, 'packages/pi-skillful/src/config.ts');
    assert.equal(readFileSync(configPath, 'utf8'), readFileSync(join(root, 'packages/pi-skillful/src/config.ts'), 'utf8'));
    const oldMeta = readFileSync(join(dir, 'upstreams/pi-skillful.json'), 'utf8');
    writeFileSync(join(dir, 'packages/pi-skillful/marker'), 'keep');
    writeFileSync(join(dir, 'fixture/packages/pi-skillful/src/config.ts'), '// conflicting upstream');
    const failure = spawnSync('sh', args, { env, encoding: 'utf8' });
    assert.notEqual(failure.status, 0);
    assert.equal(readFileSync(join(dir, 'packages/pi-skillful/marker'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(dir, 'upstreams/pi-skillful.json'), 'utf8'), oldMeta);
    cpSync(join(root, 'packages/pi-skillful/src/config.ts'), join(dir, 'fixture/packages/pi-skillful/src/config.ts'));
    run('git', ['apply', '--reverse', '--include=packages/pi-skillful/src/config.ts', join(dir, 'patches/pi-skillful.patch')], { cwd: join(dir, 'fixture') });
    const mv = run('which', ['mv']).stdout.trim();
    writeFileSync(join(dir, 'bin/mv'), `#!/bin/sh
case "$1" in */tree/packages/pi-skillful) exit 1 ;; esac
exec ${JSON.stringify(mv)} "$@"
`, { mode: 0o755 });
    assert.notEqual(spawnSync('sh', args, { env }).status, 0);
    assert.equal(readFileSync(join(dir, 'packages/pi-skillful/marker'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(dir, 'upstreams/pi-skillful.json'), 'utf8'), oldMeta);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('telemetry disabled avoids import; absent dependency skips; other errors propagate', async () => {
  const dir = temporary();
  const previous = process.env.PI_TELEMETRY;
  const previousCI = process.env.CI;
  const previousOffline = process.env.PI_OFFLINE;
  try {
    let source = readFileSync(join(root, 'packages/pi-skillful/src/install-telemetry.ts'), 'utf8')
      .replace('import { getAgentDir } from "@earendil-works/pi-coding-agent";', `const getAgentDir = () => ${JSON.stringify(dir)};`);
    // Substitute import only: never resolve installed telemetry or send network requests.
    source = stripTypeScriptTypes(source)
      .replace('await import("@mocito/install-telemetry")', 'await globalThis.skillfulTelemetryImport()')
      .replace('version: getPackageVersion(),', 'version: "fixture",');
    writeFileSync(join(dir, 'telemetry.mjs'), source);
    const telemetry = await import(pathToFileURL(join(dir, 'telemetry.mjs')).href);
    process.env.PI_TELEMETRY = '0';
    globalThis.skillfulTelemetryImport = () => { throw new Error('must not import'); };
    await telemetry.reportInstallTelemetry();
    process.env.PI_TELEMETRY = '1';
    process.env.CI = 'false';
    process.env.PI_OFFLINE = 'false';
    // Pass policy without inheriting the runner's CI-specific flags.
    const ciNames = ['GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI'];
    const saved = ciNames.map(key => [key, process.env[key]]);
    for (const key of ciNames) delete process.env[key];
    try {
      globalThis.skillfulTelemetryImport = () => { throw Object.assign(new Error("Cannot find package '@mocito/install-telemetry' imported from fixture"), { code: 'ERR_MODULE_NOT_FOUND' }); };
      await telemetry.reportInstallTelemetry();
      globalThis.skillfulTelemetryImport = () => { throw Object.assign(new Error("Cannot find package 'broken-child'"), { code: 'ERR_MODULE_NOT_FOUND' }); };
      await assert.rejects(telemetry.reportInstallTelemetry(), /broken-child/);
      let reports = 0;
      globalThis.skillfulTelemetryImport = async () => ({ reportInstallTelemetry() { reports++; return Promise.reject(new Error('offline')); } });
      await telemetry.reportInstallTelemetry();
      assert.equal(reports, 1, 'best-effort reporting must not block skill registration');
    } finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; }
  } finally {
    for (const [key, value] of [['PI_TELEMETRY', previous], ['CI', previousCI], ['PI_OFFLINE', previousOffline]]) value === undefined ? delete process.env[key] : process.env[key] = value;
    delete globalThis.skillfulTelemetryImport;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Optional local contract check. CI stays dependency-free; never install a host SDK here.
test('installed SDK contract: lock contention, entry loading and stale-menu changes', {
  skip: !process.env.SKILLFUL_SDK_ROOT,
}, async () => {
  const dir = temporary();
  const saved = ['PI_CODING_AGENT_DIR', 'PI_TELEMETRY', 'PI_OFFLINE', 'JITI_FS_CACHE'].map(key => [key, process.env[key]]);
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_TELEMETRY = '0';
    process.env.PI_OFFLINE = '1';
    process.env.JITI_FS_CACHE = '0';
    const sdkRoot = process.env.SKILLFUL_SDK_ROOT;
    const { SettingsManager } = await import(pathToFileURL(join(sdkRoot, 'dist/core/settings-manager.js')).href);
    globalThis.skillfulSDK = (...args) => SettingsManager.create(...args);
    const config = await loadConfig(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"packages":["kept"],"skillful":{"custom":7}}');
    await config.writeHiddenSkills('global', dir, ['hidden']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { packages: ['kept'], skillful: { custom: 7, hiddenSkills: ['hidden'] } });
    mkdirSync(path + '.lock');
    const before = readFileSync(path, 'utf8');
    await assert.rejects(config.writeToggleSlots('global', dir, { 1: 'one' }));
    assert.equal(readFileSync(path, 'utf8'), before);
    rmSync(path + '.lock', { recursive: true });
    const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, 'dist/core/extensions/loader.js')).href);
    const result = await loadExtensions([join(root, 'packages/pi-skillful/index.ts')], dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has('skillful'));
    assert.ok(result.extensions[0].handlers.has('resources_discover'));
    assert.ok(result.extensions[0].handlers.has('input'));
    assert.equal(existsSync(join(dir, 'extensions/skillful-install.json')), false);

    const { initTheme } = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
    initTheme('dark');
    writeFileSync(join(dir, 'menu-skill.md'), '# fixture');
    result.runtime.getCommands = () => [{ name: 'skill:menu-skill', source: 'skill', sourceInfo: { origin: 'top-level', source: 'auto', scope: 'user', path: join(dir, 'menu-skill.md') } }];
    let menu;
    await result.extensions[0].commands.get('skillful').handler('', {
      cwd: dir, mode: 'tui', isProjectTrusted: () => false,
      ui: {
        custom: async factory => { menu = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, () => {}); },
        notify(message) { assert.fail(message); },
      },
    });
    // Another sync finishes after opening the menu, before a visibility change and slot assignment.
    writeFileSync(path, '{"skillful":{"hiddenSkills":["from-sync"],"toggleSlots":{"1":"from-sync"}}}');
    menu.settingsList.onChange('menu-skill', 'hide');
    menu.handleInput('2');
    await menu.saveQueue;
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).skillful, {
      hiddenSkills: ['from-sync'], toggleSlots: { 1: 'from-sync', 2: 'menu-skill' },
      visibility: { 'agent:menu-skill.md': 'hide' },
    });
    const projectPath = join(dir, '.pi/settings.json');
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(projectPath, '{"other":1,"skillful":{"hiddenSkills":[],"custom":9}}');
    await result.extensions[0].commands.get('skillful').handler('', {
      cwd: dir, mode: 'tui', isProjectTrusted: () => true,
      ui: {
        custom: async factory => { menu = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, () => {}); },
        notify(message) { assert.fail(message); },
      },
    });
    writeFileSync(projectPath, '{"other":2,"skillful":{"hiddenSkills":[],"custom":10,"toggleSlots":{"1":"not-loaded","3":"latest"},"visibility":{"project:other.md":"hide"}}}');
    menu.settingsList.onChange('menu-skill', 'show');
    menu.handleInput('1');
    await menu.saveQueue;
    let project = JSON.parse(readFileSync(projectPath, 'utf8'));
    assert.deepEqual(project, { other: 2, skillful: {
      hiddenSkills: [], custom: 10, toggleSlots: { 1: 'menu-skill', 3: 'latest' },
      visibility: { 'project:other.md': 'hide', 'project:menu-skill.md': 'show' },
    } });
    menu.settingsList.onChange('menu-skill', 'inherit');
    await menu.saveQueue;
    project = JSON.parse(readFileSync(projectPath, 'utf8'));
    assert.equal(project.skillful.visibility['project:menu-skill.md'], 'inherit');
    mkdirSync(projectPath + '.lock');
    const unchanged = readFileSync(projectPath, 'utf8');
    await assert.rejects(config.updateSkillVisibility('project', dir, 'project:menu-skill.md', 'menu-skill', 'hide', true, true));
    assert.equal(readFileSync(projectPath, 'utf8'), unchanged);
    rmSync(projectPath + '.lock', { recursive: true });
  } finally {
    delete globalThis.skillfulSDK;
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
