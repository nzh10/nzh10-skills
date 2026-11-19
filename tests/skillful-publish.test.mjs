import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../skills/pi-steward/scripts/skillful-visibility.mjs', import.meta.url));
const id = 'hub:skills/demo/SKILL.md';
const other = 'hub:skills/other/SKILL.md';
const json = (p, x) => fs.writeFileSync(p, JSON.stringify(x, null, 2));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visibility-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), agent = path.join(root, 'agent'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo); fs.mkdirSync(agent);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', '1+test@users.noreply.github.com'); git(repo, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(repo, 'skills/demo'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'canon')); fs.mkdirSync(path.join(repo, 'pools/m1'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'skills/demo/SKILL.md'), '---\nname: demo\n---\n');
  const canon = path.join(repo, 'canon/settings.canon.json'), pool = path.join(repo, 'pools/m1/incubating.json');
  json(canon, { other: 1, skillful: { visibility: { [other]: 'hide' } } });
  json(pool, { machineId: 'm1', notes: ['keep'] });
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'HEAD');
  git(repo, 'config', 'core.hooksPath', '.githooks');
  fs.writeFileSync(path.join(repo, '.git/info/no-upload-personal'), 'private-example\n');
  json(path.join(agent, 'machine.json'), { machineId: 'm1', hubRepoPath: repo });
  json(path.join(agent, 'settings.json'), { skillful: { visibility: { [id]: 'show', [other]: 'hide' } } });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: agent, HOME: root } });
  const load = p => JSON.parse(fs.readFileSync(p));
  return { repo, agent, canon, pool, run, load };
}
const ok = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test('collects one explicit local item and promotes with a baseline', t => {
  const f = fixture(t);
  assert.equal(ok(f.run('collect', '--id', id)).writes, 'pool');
  assert.deepEqual(f.load(f.pool).settings.skillful.visibility, { [id]: { base: null, value: 'show' } });
  const preview = ok(f.run('promote', '--id', id, '--pool', 'm1'));
  assert.equal(preview.current, null); assert.equal(preview.target, 'show'); assert.equal(preview.writes, 'none');
  assert.notEqual(f.run('promote', '--id', id, '--pool', 'm1', '--apply').status, 0);
  assert.equal(ok(f.run('promote', '--id', id, '--value', preview.target, '--apply', '--expected', String(preview.baseline))).writes, 'canon');
  assert.deepEqual(f.load(f.canon).skillful.visibility, { [other]: 'hide', [id]: 'show' });
  assert.equal(ok(f.run('promote', '--id', id, '--value', preview.target, '--apply', '--expected', String(preview.baseline))).writes, 'none');
  assert.deepEqual(f.load(f.pool).notes, ['keep']);
});

test('direct preview, conflict, unrelated changes and idempotency', t => {
  const f = fixture(t);
  const preview = ok(f.run('promote', '--id', id, '--value', 'show'));
  assert.equal(preview.baseline, null);
  let doc = f.load(f.canon); doc.skillful.visibility[id] = 'hide'; doc.skillful.visibility[other] = 'show'; json(f.canon, doc);
  assert.notEqual(f.run('promote', '--id', id, '--value', 'show', '--apply', '--expected', 'null').status, 0);
  assert.equal(f.load(f.canon).skillful.visibility[id], 'hide');
  assert.equal(ok(f.run('promote', '--id', id, '--value', 'show', '--apply', '--expected', 'hide')).writes, 'canon');
  assert.equal(f.load(f.canon).skillful.visibility[other], 'show');
  assert.equal(ok(f.run('promote', '--id', id, '--value', 'show', '--apply', '--expected', 'hide')).writes, 'none');
});

test('rejects unsafe input, missing local choice, cache, symlinks and failed preflight', t => {
  const f = fixture(t);
  assert.notEqual(f.run('collect', '--id', 'hub:skills/../canon/settings.canon.json').status, 0);
  assert.notEqual(f.run('collect', '--id', other, '--content-promoted').status, 0);
  assert.notEqual(f.run('promote', '--id', id, '--value', 'show', '--apply').status, 0);
  fs.mkdirSync(path.join(f.repo, 'skills/link')); fs.symlinkSync(path.join(f.repo, 'skills/demo/SKILL.md'), path.join(f.repo, 'skills/link/SKILL.md'));
  assert.notEqual(f.run('collect', '--id', 'hub:skills/link/SKILL.md', '--content-promoted').status, 0);
  const before = fs.readFileSync(f.pool, 'utf8');
  git(f.repo, 'config', '--unset', 'core.hooksPath');
  assert.notEqual(f.run('collect', '--id', id).status, 0);
  assert.equal(fs.readFileSync(f.pool, 'utf8'), before);
  json(path.join(f.agent, 'machine.json'), { machineId: 'm1' });
  assert.notEqual(f.run('collect', '--id', id).status, 0);
});

test('pool baseline detects same-entry changes but allows convergence', t => {
  const f = fixture(t);
  ok(f.run('collect', '--id', id));
  const doc = f.load(f.canon); doc.skillful.visibility[id] = 'hide'; json(f.canon, doc);
  const preview = ok(f.run('promote', '--id', id, '--pool', 'm1'));
  const apply = () => f.run('promote', '--id', id, '--value', preview.target, '--apply', '--expected', String(preview.baseline));
  assert.match(apply().stderr, /canon conflict/);
  doc.skillful.visibility[id] = 'show'; json(f.canon, doc);
  assert.equal(ok(apply()).writes, 'none');
});

test('unpublished content requires explicit promotion and staged files block writes', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'skills/new'));
  fs.writeFileSync(path.join(f.repo, 'skills/new/SKILL.md'), 'skill');
  const newId = 'hub:skills/new/SKILL.md';
  assert.notEqual(f.run('promote', '--id', newId, '--value', 'hide').status, 0);
  assert.equal(ok(f.run('promote', '--id', newId, '--value', 'hide', '--content-promoted')).writes, 'none');
  git(f.repo, 'add', 'skills/new/SKILL.md');
  const before = fs.readFileSync(f.canon, 'utf8');
  assert.notEqual(f.run('promote', '--id', newId, '--value', 'hide', '--apply', '--expected', 'null', '--content-promoted').status, 0);
  assert.equal(fs.readFileSync(f.canon, 'utf8'), before);
});
