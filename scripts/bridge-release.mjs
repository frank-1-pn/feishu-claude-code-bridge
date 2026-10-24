#!/usr/bin/env node
/** Offline integrity tooling. Never installs, imports runtime code or starts a service. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROFILE = 'releases/codex-runtime-v1.json';
const SKILL = 'codex-config/skills/feishu-bot-runtime/';
const HEX = /^[0-9a-f]{40}$/;
const PLATFORMS = ['darwin', 'win32'];
const WINDOWS = new Set(['configure-feishu-watchdog.ps1', 'ensure-bot.ps1', 'feishu-watchdog.ps1', 'invoke-bounded-script.ps1', 'resolve-codex-pty.ps1', 'run-watchdog-hidden.vbs', 'start-bot.ps1', 'start-codex-bridge.ps1', 'status-codex-bridge.ps1', 'subscriber-health.ps1']);
const BUILD = new Set(['scripts/build-lark-heartbeat.py', 'scripts/build-lark-heartbeat-macos.py', 'patches/lark-ws-health/bridge_ws_health.go', 'patches/lark-ws-health/bridge_ws_health_test.go', 'patches/lark-ws-health/macos_socket_integration_test.go']);
const DENIED = /(^|[\/._-])(state|logs?|secrets?|credentials?|tokens?|passwords?|private|downloads?|backups?|bin|node_modules|\.git|\.env)([\/._-]|$)/i;
export class ReleaseError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new ReleaseError(code); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('invalid_schema');
}
function safePath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(value) || value.includes('//') || value.split('/').some(s => !s || s === '.' || s === '..' || s.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) || DENIED.test(value)) fail('unsafe_path');
  return value;
}
function git(repo, args) {
  try { return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: '0' } }); }
  catch { fail('git_read_failed'); }
}
function blob(repo, ref, source) { return git(repo, ['show', `${ref}:${source}`]); }
function parse(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_json'); } }
function moduleFile(name) {
  return !name.includes('.test.') && /^(codex-bridge-[a-z0-9-]+|codex-managed-[a-z0-9-]+|macos-[a-z0-9-]+|orca-pty-rpc|resolve-codex-pty|lark-send|start-lark-append|migrate-codex-inbox)\.mjs$/.test(name);
}
function eligible(source) {
  if (source.startsWith(SKILL)) return /\.(md|yaml)$/.test(source) && !DENIED.test(source);
  if (!source.startsWith('daemon/')) return false;
  const name = source.slice(7);
  return !name.includes('/') && (moduleFile(name) || WINDOWS.has(name));
}
function mapping(source) {
  safePath(source);
  if (!eligible(source)) fail('non_release_file');
  const skill = source.startsWith(SKILL);
  return { source, area: skill ? 'skill' : 'runtime', path: skill ? source.slice(SKILL.length) : source.slice(7), platforms: !skill && WINDOWS.has(source.slice(7)) ? ['win32'] : !skill && /^daemon\/macos-/.test(source) ? ['darwin'] : [...PLATFORMS] };
}
function validateDependency(dep, platform) {
  exactKeys(dep, ['cli_revision', 'sdk_revision', 'build_script', 'source_files', 'binary_install_path', 'build_manifest_required', 'preserve_existing_subscriber']);
  if (!HEX.test(dep.cli_revision) || !HEX.test(dep.sdk_revision) || dep.build_script !== (platform === 'darwin' ? 'scripts/build-lark-heartbeat-macos.py' : 'scripts/build-lark-heartbeat.py') || dep.binary_install_path !== (platform === 'darwin' ? 'bin/lark-cli-heartbeat' : 'bin/lark-cli.exe') || dep.build_manifest_required !== true || dep.preserve_existing_subscriber !== true || !Array.isArray(dep.source_files)) fail('invalid_dependency');
  const expected = [...BUILD].filter(s => s === dep.build_script || s.startsWith('patches/'));
  if (canonical([...dep.source_files].sort()) !== canonical(expected.sort())) fail('invalid_dependency');
}
/** Generate only from a clean repository and an independently selected full commit ID. */
export function generateManifest({ repo, ref, profilePath = PROFILE }) {
  if (!HEX.test(ref || '')) fail('exact_commit_required');
  if (profilePath !== PROFILE) fail('invalid_profile_path');
  if (git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) fail('dirty_source');
  if (git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim() !== ref) fail('exact_commit_required');
  const tree = git(repo, ['rev-parse', `${ref}^{tree}`]).toString().trim();
  const entries = new Map();
  for (const record of git(repo, ['ls-tree', '-rz', '--full-tree', ref]).toString().split('\0').filter(Boolean)) {
    const split = record.indexOf('\t'); const [mode, type] = record.slice(0, split).split(' ');
    entries.set(record.slice(split + 1), { mode, type });
  }
  const profileBytes = blob(repo, ref, profilePath);
  const profile = parse(profileBytes);
  exactKeys(profile, ['schema_version', 'name', 'files', 'dependencies']);
  if (profile.schema_version !== 1 || profile.name !== 'codex-runtime-v1' || !Array.isArray(profile.files)) fail('invalid_profile');
  const regular = source => { const item = entries.get(source); if (!item) fail('missing_source_file'); if (!['100644', '100755'].includes(item.mode) || item.type !== 'blob') fail('non_regular_source'); };
  regular(profilePath);
  const wanted = [...entries.keys()].filter(eligible).sort();
  const requested = new Set();
  const files = profile.files.map(source => {
    const item = mapping(source); const folded = source.toLowerCase();
    if (requested.has(folded)) fail('duplicate_file'); requested.add(folded); regular(source);
    const bytes = blob(repo, ref, source);
    if (bytes.includes(0)) fail('binary_source');
    return { ...item, sha256: sha(bytes), bytes: bytes.length };
  }).sort((a, b) => a.source.localeCompare(b.source, 'en'));
  if (canonical([...profile.files].sort()) !== canonical(wanted)) fail('incomplete_profile');
  exactKeys(profile.dependencies, PLATFORMS);
  const dependencies = {};
  for (const platform of PLATFORMS) {
    const dep = profile.dependencies[platform]; validateDependency(dep, platform);
    for (const source of dep.source_files) { safePath(source); regular(source); if (blob(repo, ref, source).includes(0)) fail('binary_source'); }
    const script = blob(repo, ref, dep.build_script).toString('utf8');
    if (!script.includes(`CLI_REV='${dep.cli_revision}'`) || !script.includes(`SDK_REV='${dep.sdk_revision}'`)) fail('dependency_pin_mismatch');
    dependencies[platform] = { ...dep, source_files: dep.source_files.map(source => ({ source, sha256: sha(blob(repo, ref, source)) })).sort((a, b) => a.source.localeCompare(b.source, 'en')) };
  }
  return { schema_version: 1, kind: 'codex-bridge-release', commit: ref, tree, profile: { path: profilePath, sha256: sha(profileBytes) }, files, dependencies };
}
/** Regeneration binds every byte/field to the trusted exact source commit, not manifest claims. */
export function verifyManifest({ repo, ref, manifest }) {
  const expected = generateManifest({ repo, ref });
  if (canonical(manifest) !== canonical(expected)) fail('manifest_mismatch');
  return expected;
}
function readRegular(root, relative) {
  const absoluteRoot = path.resolve(root);
  let current = path.parse(absoluteRoot).root;
  for (const component of absoluteRoot.slice(current.length).split(path.sep).filter(Boolean).concat(relative.split('/'))) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return { reason: 'missing' }; fail('installed_read_failed'); }
    if (stat.isSymbolicLink()) return { reason: 'symlink' };
    if (current !== path.join(absoluteRoot, ...relative.split('/')) && !stat.isDirectory()) return { reason: 'non_directory' };
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile()) return { reason: 'non_regular' };
  try { return { bytes: fs.readFileSync(current) }; } catch { fail('installed_read_failed'); }
}
/** Reads only allowlisted installed files; unknown host files are neither enumerated nor touched. */
export function checkInstalled({ repo, ref, manifest, platform, area = 'all', runtimeRoot, skillRoot }) {
  const verified = verifyManifest({ repo, ref, manifest });
  if (!PLATFORMS.includes(platform) || !['all', 'runtime', 'skill'].includes(area)) fail('invalid_scope');
  const roots = { runtime: runtimeRoot, skill: skillRoot };
  const selected = area === 'all' ? ['runtime', 'skill'] : [area];
  if (selected.some(key => typeof roots[key] !== 'string' || !roots[key])) fail('installation_root_required');
  const files = verified.files.filter(f => selected.includes(f.area) && f.platforms.includes(platform));
  const issues = [];
  for (const file of files) {
    const read = readRegular(roots[file.area], file.path);
    const reason = read.reason || (sha(read.bytes) !== file.sha256 ? 'hash_mismatch' : null);
    if (reason) issues.push({ area: file.area, path: file.path, reason });
  }
  return { ok: issues.length === 0, operation: 'check-installed', commit: ref, platform, area, checked_files: files.length, issues, subscriber_checked: false, process_checked: false, real_human_acceptance: 'not_checked' };
}
function readManifest(filename) {
  try { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail('invalid_manifest_file'); return parse(fs.readFileSync(filename)); }
  catch (error) { if (error instanceof ReleaseError) throw error; fail('manifest_read_failed'); }
}
function cli(argv) {
  const [operation, ...args] = argv;
  if (!['generate', 'verify', 'check-installed'].includes(operation)) fail('invalid_operation');
  const allowed = ['repo', 'ref', ...(operation === 'generate' ? [] : ['manifest']), ...(operation === 'check-installed' ? ['platform', 'area', 'runtime-root', 'skill-root'] : [])];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid_arguments');
    options[key] = args[i + 1];
  }
  if (!options.repo || !options.ref) fail('invalid_arguments');
  const input = { repo: options.repo, ref: options.ref };
  if (operation === 'generate') return generateManifest(input);
  if (!options.manifest) fail('invalid_arguments');
  const manifest = readManifest(options.manifest);
  if (operation === 'verify') { const result = verifyManifest({ ...input, manifest }); return { ok: true, operation, commit: result.commit, checked_files: result.files.length }; }
  return checkInstalled({ ...input, manifest, platform: options.platform, area: options.area, runtimeRoot: options['runtime-root'], skillRoot: options['skill-root'] });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = cli(process.argv.slice(2)); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.ok === false) process.exitCode = 1; }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof ReleaseError ? error.code : 'release_check_failed' }) + '\n'); process.exitCode = 1; }
}
