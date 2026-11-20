import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { syncCacheRepoToUpstream } from '../extensions/pi-steward.ts';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tlsError = 'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to example.invalid:443';

function fixture(t, behavior) {
  const root = mkdtempSync(join(tmpdir(), 'steward-fetch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent');
  const cache = join(agent, 'git', 'cache');
  const origin = join(root, 'origin');
  const count = join(root, 'attempts');
  git('init', '-q', '-b', 'main', origin);
  const commit = text => {
    writeFileSync(join(origin, 'version'), text);
    git('-C', origin, 'add', 'version');
    git('-C', origin, '-c', 'user.name=Test', '-c', 'user.email=1+test@users.noreply.github.com', 'commit', '-qm', text);
  };
  commit('old');
  git('clone', '-q', origin, cache);
  commit('new');
  const remote = join(root, 'transport');
  writeFileSync(remote, `#!/bin/sh
printf 'attempt\\n' >> "$1"
case "$3" in
  permanent) printf 'fatal: Authentication failed\\n' >&2; exit 1 ;;
  always) printf '%s\\n' '${tlsError}' >&2; exit 1 ;;
  once) if [ "$(wc -l < "$1")" -eq 1 ]; then printf '%s\\n' '${tlsError}' >&2; exit 1; fi ;;
esac
exec git upload-pack "$2"
`, { mode: 0o700 });
  git('-C', cache, 'config', 'protocol.ext.allow', 'always');
  const extArg = value => value.replaceAll('%', '%%').replaceAll(' ', '% ');
  git('-C', cache, 'remote', 'set-url', 'origin', `ext::${[remote, count, origin, behavior].map(extArg).join(' ')}`);
  return {
    sync: signal => syncCacheRepoToUpstream(cache, agent, signal),
    attempts: () => existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0,
    content: () => readFileSync(join(cache, 'version'), 'utf8'),
  };
}

const options = { skip: process.platform === 'win32' && 'requires a POSIX Git transport' };

test('cache fetch retries a TLS disconnect once and applies the fetched update', options, async t => {
  const f = fixture(t, 'once');
  assert.match((await f.sync()).shortSha ?? '', /^[0-9a-f]+$/);
  assert.equal(f.attempts(), 2);
  assert.equal(f.content(), 'new');
});

test('cache fetch reports Git stderr after the second TLS disconnect and keeps the old checkout', options, async t => {
  const f = fixture(t, 'always');
  const result = await f.sync();
  assert.equal(result.ok, false);
  assert.ok(result.error.includes(tlsError));
  assert.ok(result.error.includes('after 2 attempts'));
  assert.equal(f.attempts(), 2);
  assert.equal(f.content(), 'old');
});

test('cache fetch does not retry a permanent authentication error', options, async t => {
  const f = fixture(t, 'permanent');
  const result = await f.sync();
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Authentication failed'));
  assert.equal(f.attempts(), 1);
  assert.equal(f.content(), 'old');
});

test('cache fetch stops retrying when its session cancels', options, async t => {
  const f = fixture(t, 'always');
  const controller = new AbortController();
  const syncing = f.sync(controller.signal);
  try {
    for (let i = 0; i < 100 && !f.attempts(); i++) await delay(10);
    assert.equal(f.attempts(), 1);
  } finally {
    controller.abort();
    assert.deepEqual(await syncing, { ok: true, changed: false });
  }
  assert.equal(f.attempts(), 1);
  assert.equal(f.content(), 'old');
});
