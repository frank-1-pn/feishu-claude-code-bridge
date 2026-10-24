import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, generateManifest, verifyManifest, checkInstalled } from './bridge-release.mjs';
const tool = fileURLToPath(new URL('./bridge-release.mjs', import.meta.url));
const actualProfile = JSON.parse(fs.readFileSync(new URL('../releases/codex-runtime-v1.json', import.meta.url)));
function fixture(t, change = () => {}) {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-test-')));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const repo = path.join(outer, 'source'); fs.mkdirSync(repo);
  function put(source, contents) { const file = path.join(repo, source); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
  const profile = structuredClone(actualProfile);
  profile.files = ['daemon/codex-bridge-worker.mjs', 'daemon/macos-service.mjs', 'daemon/start-codex-bridge.ps1', 'codex-config/skills/feishu-bot-runtime/SKILL.md'];
  for (const file of profile.files) put(file, `// public fixture: ${file}\n`);
  for (const dep of Object.values(profile.dependencies)) {
    for (const source of dep.source_files) put(source, source === dep.build_script ? `CLI_REV='${dep.cli_revision}'\nSDK_REV='${dep.sdk_revision}'\n` : '// public patch\n');
  }
  change({ repo, outer, put, profile });
  put('releases/codex-runtime-v1.json', JSON.stringify(profile));
  const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init', '--quiet']); git(['add', '--', '.']);
  // Test-only synthetic repositories; no commits are created in the project checkout.
  git(['-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'public test fixture']);
  return { repo, outer, put, git, ref: git(['rev-parse', 'HEAD']) };
}
function rejects(fn, code) { assert.throws(fn, error => error.code === code); }
function installed(f, manifest) {
  const roots = { runtimeRoot: path.join(f.outer, 'runtime'), skillRoot: path.join(f.outer, 'skill') };
  fs.mkdirSync(roots.runtimeRoot); fs.mkdirSync(roots.skillRoot);
  for (const file of manifest.files) {
    const root = roots[file.area + 'Root']; const dest = path.join(root, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, execFileSync('git', ['-C', f.repo, 'show', `${f.ref}:${file.source}`]));
  }
  return roots;
}
test('generation is byte-reproducible and pinned to exact source commit', t => {
  const f = fixture(t); const first = generateManifest(f); const second = generateManifest(f);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.commit, f.ref); assert.equal(first.files.length, 4);
  assert.deepEqual(verifyManifest({ ...f, manifest: first }), first);
  rejects(() => generateManifest({ ...f, ref: 'HEAD' }), 'exact_commit_required');
  rejects(() => generateManifest({ ...f, ref: 'stable/codex' }), 'exact_commit_required');
  assert.ok(!JSON.stringify(first).includes(f.outer));
});
test('source checking refuses tracked changes and untracked inputs', t => {
  const f = fixture(t); f.put('scratch.md', 'untracked');
  rejects(() => generateManifest(f), 'dirty_source'); fs.unlinkSync(path.join(f.repo, 'scratch.md'));
  f.put('daemon/codex-bridge-worker.mjs', '// edited'); rejects(() => generateManifest(f), 'dirty_source');
});
test('manifest tampering cannot bless arbitrary installed bytes or dependency pins', t => {
  const f = fixture(t); const manifest = generateManifest(f);
  for (const mutate of [m => { m.files[0].sha256 = '0'.repeat(64); }, m => m.files.pop(), m => { m.dependencies.darwin.cli_revision = '0'.repeat(40); }, m => { m.files[0].path = '../private.json'; }, m => { m.extra = 'untrusted'; }]) {
    const altered = structuredClone(manifest); mutate(altered);
    rejects(() => verifyManifest({ ...f, manifest: altered }), 'manifest_mismatch');
  }
});
test('profile completeness detects unlisted runtime modules', t => {
  const f = fixture(t, ({ put }) => put('daemon/codex-bridge-added.mjs', '// added'));
  rejects(() => generateManifest(f), 'incomplete_profile');
});
test('profile refuses missing source, duplicate, private and unsafe entries', async t => {
  for (const [entry, code] of [['daemon/codex-bridge-missing.mjs', 'missing_source_file'], ['../private.json', 'unsafe_path'], ['daemon/state/messages.json', 'unsafe_path'], ['daemon/bot-registry.json', 'non_release_file'], ['daemon/codex-thread-bindings.json', 'non_release_file'], ['daemon/bin/lark-cli.exe', 'unsafe_path'], ['daemon/codex-bridge-secrets.mjs', 'unsafe_path'], ['daemon\\codex-bridge-worker.mjs', 'unsafe_path'], ['codex-config/skills/feishu-bot-runtime/references/NUL.md', 'unsafe_path'], ['codex-config/skills/feishu-bot-runtime/references/.env.yaml', 'unsafe_path'], ['daemon/codex-bridge-worker.mjs', 'duplicate_file']]) {
    await t.test(entry, sub => { const f = fixture(sub, ({ profile }) => profile.files.push(entry)); rejects(() => generateManifest(f), code); });
  }
});
test('source symlinks and binary runtime blobs are refused', async t => {
  await t.test('symlink', sub => {
    const f = fixture(sub, ({ repo }) => { const file = path.join(repo, 'daemon/codex-bridge-worker.mjs'); fs.unlinkSync(file); fs.symlinkSync('macos-service.mjs', file); });
    rejects(() => generateManifest(f), 'non_regular_source');
  });
  await t.test('binary', sub => {
    const f = fixture(sub, ({ put }) => put('daemon/codex-bridge-worker.mjs', Buffer.from([1, 0, 2])));
    rejects(() => generateManifest(f), 'binary_source');
  });
});
test('dependency pins must agree with fixed build script', t => {
  const f = fixture(t, ({ profile }) => { profile.dependencies.darwin.cli_revision = '0'.repeat(40); });
  rejects(() => generateManifest(f), 'dependency_pin_mismatch');
});
test('installed checks are scoped and preserve private and unknown runtime files', t => {
  const f = fixture(t); const manifest = generateManifest(f); const roots = installed(f, manifest);
  const privateFile = path.join(roots.runtimeRoot, 'codex-thread-bindings.json');
  fs.writeFileSync(privateFile, 'private sentinel'); fs.mkdirSync(path.join(roots.runtimeRoot, 'state'));
  fs.writeFileSync(path.join(roots.runtimeRoot, 'state', 'do-not-read'), 'private state');
  // Unknown symlink must not be traversed either.
  fs.symlinkSync('/missing-unknown-target', path.join(roots.runtimeRoot, 'unknown-host-file'));
  const before = fs.statSync(privateFile);
  const result = checkInstalled({ ...f, manifest, ...roots, platform: 'darwin' });
  assert.equal(result.ok, true); assert.equal(result.checked_files, 3); assert.equal(result.subscriber_checked, false);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'private sentinel');
  assert.equal(fs.statSync(privateFile).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(path.join(roots.runtimeRoot, 'state', 'do-not-read'), 'utf8'), 'private state');
  fs.rmSync(roots.runtimeRoot, { recursive: true });
  assert.equal(checkInstalled({ ...f, manifest, skillRoot: roots.skillRoot, platform: 'win32', area: 'skill' }).ok, true);
  rejects(() => checkInstalled({ ...f, manifest, platform: 'darwin' }), 'installation_root_required');
});
test('installed check reports missing/mismatch and rejects symlink escapes', t => {
  const f = fixture(t); const manifest = generateManifest(f); const roots = installed(f, manifest);
  const target = path.join(roots.runtimeRoot, 'codex-bridge-worker.mjs');
  fs.unlinkSync(target);
  let result = checkInstalled({ ...f, manifest, ...roots, platform: 'darwin' });
  assert.equal(result.ok, false); assert.equal(result.issues[0].reason, 'missing');
  fs.writeFileSync(target, 'wrong bytes'); result = checkInstalled({ ...f, manifest, ...roots, platform: 'darwin' });
  assert.equal(result.issues[0].reason, 'hash_mismatch'); fs.unlinkSync(target);
  fs.symlinkSync(path.join(f.repo, 'daemon/codex-bridge-worker.mjs'), target);
  assert.equal(checkInstalled({ ...f, manifest, ...roots, platform: 'darwin' }).issues[0].reason, 'symlink');
  const alias = path.join(f.outer, 'runtime-alias'); fs.symlinkSync(roots.runtimeRoot, alias);
  assert.equal(checkInstalled({ ...f, manifest, ...roots, runtimeRoot: alias, platform: 'darwin' }).issues.every(i => i.reason === 'symlink'), true);
});
test('CLI emits safe machine-readable errors without paths, config contents or Git stderr', t => {
  const f = fixture(t); const result = spawnSync(process.execPath, [tool, 'generate', '--repo', path.join(f.outer, 'does-not-exist'), '--ref', f.ref], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'git_read_failed' });
  assert.ok(!result.stdout.includes(f.outer));
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});
