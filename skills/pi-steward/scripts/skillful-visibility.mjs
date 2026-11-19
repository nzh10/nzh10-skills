#!/usr/bin/env node
// Explicit, single-entry Skillful visibility collection and promotion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fail = (message) => { throw new Error(message); };
const object = (v, label) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(`${label} must be an object`);
const value = (v, nullable = false) => (v === 'show' || v === 'hide' || (nullable && v === null)) ? v : fail('visibility must be show or hide (or null for a baseline)');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const read = (p) => object(JSON.parse(fs.readFileSync(p, 'utf8')), p);
const entry = (doc, keys, id) => {
  let node = doc;
  for (const key of keys) {
    if (!own(node, key)) return undefined;
    node = object(node[key], key);
  }
  return own(node, id) ? node[id] : undefined;
};
const setEntry = (doc, keys, id, val) => {
  let node = doc;
  for (const key of keys) {
    if (!own(node, key)) node[key] = {};
    node = object(node[key], key);
  }
  node[id] = val;
};
// Reject symlinks in every existing component, including the target.
function safePath(root, relative, allowMissing = false) {
  let p = root;
  for (const part of relative.split('/')) {
    p = path.join(p, part);
    try { if (fs.lstatSync(p).isSymbolicLink()) fail('symlink in repository path'); }
    catch (e) { if (e.code !== 'ENOENT' || !allowMissing) throw e; }
  }
  return p;
}
function atomicWrite(p, data) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(p), '.visibility-'));
  const next = path.join(tmp, 'next');
  try {
    const mode = fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : 0o600;
    fs.writeFileSync(next, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode });
    fs.renameSync(next, p);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function parse(args) {
  const command = args.shift();
  if (!['collect', 'promote'].includes(command)) fail('usage: collect --id ID [--content-promoted] | promote --id ID (--pool MACHINE | --value show|hide) [--apply --expected null|show|hide] [--content-promoted]');
  const opts = {};
  while (args.length) {
    const key = args.shift();
    if (!['--id', '--pool', '--value', '--apply', '--expected', '--content-promoted'].includes(key) || own(opts, key)) fail(`invalid or duplicate option: ${key}`);
    if (key === '--apply' || key === '--content-promoted') opts[key] = true;
    else { const arg = args.shift(); if (!arg || arg.startsWith('--')) fail(`missing value for ${key}`); opts[key] = arg; }
  }
  if (!opts['--id']) fail('--id is required');
  if (command === 'collect' && (opts['--pool'] || opts['--value'] || opts['--apply'] || opts['--expected'])) fail('collect only accepts --id and --content-promoted');
  if (command === 'promote' && (!!opts['--pool'] === !!opts['--value'])) fail('choose exactly one of --pool and --value');
  if (opts['--apply'] && opts['--pool']) fail('pool preview is read-only; apply with its exact --id, --value and --expected');
  if (opts['--expected'] && (!opts['--apply'] || !opts['--value'])) fail('--expected is only for direct apply');
  if (opts['--apply'] && opts['--value'] && !opts['--expected']) fail('direct apply requires --expected from preview');
  return { command, opts };
}
function main() {
  const { command, opts } = parse(process.argv.slice(2));
  const agent = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'));
  const markerPath = path.join(agent, 'machine.json');
  const marker = read(markerPath);
  if (typeof marker.machineId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marker.machineId) || typeof marker.hubRepoPath !== 'string' || !marker.hubRepoPath.trim()) fail('invalid writable machine marker');
  const rawHub = marker.hubRepoPath.trim().replace(/^~(?=\/|$)/, os.homedir());
  const hub = fs.realpathSync(path.resolve(rawHub));
  const cache = path.resolve(agent, 'git');
  const realCache = fs.existsSync(cache) ? fs.realpathSync(cache) : cache;
  const relCache = path.relative(realCache, hub);
  if (!relCache || (!relCache.startsWith('..' + path.sep) && relCache !== '..' && !path.isAbsolute(relCache))) fail('hub is in package cache');
  if (!fs.existsSync(path.join(hub, '.git'))) fail('hub is not a repository');
  const id = opts['--id'];
  const rel = id.startsWith('hub:') ? id.slice(4) : '';
  if (!/^skills\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(rel)) fail('invalid public skill ID');
  const skill = safePath(hub, rel);
  if (!fs.statSync(skill).isFile()) fail('skill is not a file');
  // A file not in the configured upstream requires explicit simultaneous content promotion.
  if (!opts['--content-promoted']) {
    try { execFileSync('git', ['-C', hub, 'cat-file', '-e', `@{upstream}:${rel}`], { stdio: 'ignore' }); }
    catch { fail('skill is not in upstream; explicit --content-promoted is required'); }
  }
  const canonPath = safePath(hub, 'canon/settings.canon.json');
  const canonKeys = ['skillful', 'visibility'];
  const poolKeys = ['settings', 'skillful', 'visibility'];
  const machine = opts['--pool'] || marker.machineId;
  if (!/^[A-Za-z0-9_-]+$/.test(machine)) fail('invalid pool machine ID');
  const poolRel = `pools/${machine}/incubating.json`;
  const poolPath = safePath(hub, poolRel, true);
  const readPool = () => {
    const doc = fs.existsSync(poolPath) ? read(poolPath) : { machineId: machine, incubatingPackages: [] };
    if (own(doc, 'machineId') && doc.machineId !== machine) fail('pool machineId mismatch');
    return doc;
  };
  const samePoolEntry = (a, b) => a === null ? b === null : b !== null && a.base === b.base && a.value === b.value;
  const poolEntry = (doc) => {
    const e = entry(doc, poolKeys, id);
    if (e === undefined) return null;
    object(e, 'pool entry'); value(e.base, true); value(e.value);
    if (Object.keys(e).some(k => k !== 'base' && k !== 'value')) fail('invalid pool entry');
    return e;
  };
  const canonValue = (doc) => { const v = entry(doc, canonKeys, id); return v === undefined ? null : value(v); };
  const canon = () => canonValue(read(canonPath));
  const current = canon();
  let target, baseline, initialPool;
  if (command === 'collect') {
    const local = read(path.join(agent, 'settings.json'));
    target = value(entry(local, canonKeys, id));
    initialPool = poolEntry(readPool());
    baseline = initialPool ? initialPool.base : current;
  } else if (opts['--pool']) {
    initialPool = poolEntry(readPool());
    if (!initialPool) fail('pool entry not found');
    target = initialPool.value; baseline = initialPool.base;
  } else {
    target = value(opts['--value']);
    baseline = opts['--apply'] ? value(opts['--expected'] === 'null' ? null : opts['--expected'], true) : current;
  }
  const action = command === 'collect' ? 'collect' : opts['--apply'] ? 'promote-apply' : 'promote-preview';
  const result = { action, id, current, target, baseline, writes: command === 'collect' ? 'pool' : opts['--apply'] ? 'canon' : 'none', commit: false, push: false };
  if (command === 'promote' && !opts['--apply']) { console.log(JSON.stringify(result)); return; }
  execFileSync('sh', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'steward-preflight.sh')], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000,
  });
  const gitLock = execFileSync('git', ['-C', hub, 'rev-parse', '--path-format=absolute', '--git-path', 'skillful-visibility.lock'], { encoding: 'utf8' }).trim();
  try { fs.mkdirSync(gitLock); }
  catch (error) { if (error.code === 'EEXIST') fail('another Skillful repository write holds the lock'); throw error; }
  try {
    const lockedMarker = read(markerPath);
    if (lockedMarker.machineId !== marker.machineId || lockedMarker.hubRepoPath !== marker.hubRepoPath) fail('writable machine marker changed during preflight');
    safePath(hub, rel); safePath(hub, 'canon/settings.canon.json'); safePath(hub, poolRel, true);
    if (command === 'collect') {
      if (entry(read(path.join(agent, 'settings.json')), canonKeys, id) !== target) fail('local selection changed during preflight');
      const latestCanon = canon();
      if (latestCanon !== current && latestCanon !== target) fail('canon entry changed concurrently');
      const doc = readPool();
      const latest = poolEntry(doc);
      const desired = { base: baseline, value: target };
      if (!samePoolEntry(latest, initialPool) && !samePoolEntry(latest, desired)) fail('pool entry changed concurrently');
      if (samePoolEntry(latest, desired)) result.writes = 'none';
      else {
        fs.mkdirSync(path.dirname(poolPath), { recursive: true });
        safePath(hub, poolRel, true);
        setEntry(doc, poolKeys, id, desired);
        atomicWrite(poolPath, doc);
      }
    } else {
      const doc = read(canonPath);
      const latest = canonValue(doc);
      if (latest !== baseline && latest !== target) fail(`canon conflict: expected ${baseline}, current ${latest}, target ${target}`);
      if (latest === target) result.writes = 'none';
      else { setEntry(doc, canonKeys, id, target); atomicWrite(canonPath, doc); }
      result.current = latest;
    }
  } finally { fs.rmdirSync(gitLock); }
  console.log(JSON.stringify(result));
}
try { main(); } catch (error) { console.error(error.stderr?.toString().trim() || error.message); process.exitCode = 1; }
