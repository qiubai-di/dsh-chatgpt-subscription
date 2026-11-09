#!/usr/bin/env node
// After install:local, add its immutable archive to the existing native web profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument } from 'yaml';
import { installCliHostResolution } from '../dist/cli-host-resolution.js';
import { acquireOperationLease, assertHost, atomicWrite, findDsh, readInstallation, subscriptionHome } from '../dist/runtime.js';

const { values } = parseArgs({ options: {
  home: { type: 'string' }, 'dsh-home': { type: 'string' }, dsh: { type: 'string' },
} });
const home = subscriptionHome(values.home);
const nativeHome = resolve(values['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
assert.notEqual(home, nativeHome, 'Choose the native DSH home, not the isolated subscription home.');
const installation = await readInstallation(home);
const host = await assertHost(await findDsh(values.dsh ?? installation.dshExecutable));
const artifact = join(home, 'releases', `${installation.version}-${installation.packageSha256.slice(0, 16)}.tgz`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await readFile(artifact)), installation.packageSha256, 'Release archive hash mismatch.');
const sourceVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
assert.equal(installation.version, sourceVersion, 'Run install:local for this source version first.');
const hostBefore = digest(await readFile(host.realPath));
const profile = join(nativeHome, 'profiles', 'web');
const info = await lstat(profile);
assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'The existing native web profile must be a real directory.');
const manifestPath = join(profile, 'package.json');
const patchPath = join(profile, 'cordis.patch.yml');
const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const document = parseDocument(await readFile(patchPath, 'utf8'));
assert.equal(document.errors.length, 0, 'Native profile patch must be valid YAML.');
const originalRows = document.toJS();
assert.ok(Array.isArray(originalRows), 'Native profile patch must be a list.');
const matching = originalRows.flatMap((row, index) => row?.id === 'chatgpt-subscription' ? [index] : []);
assert.ok(matching.length <= 1, 'Duplicate subscription rows require manual reconciliation.');
if (matching.length) {
  const previous = originalRows[matching[0]];
  assert.ok(!previous.name || previous.name === 'dsh-chatgpt-subscription', 'Subscription row belongs to another plugin.');
  document.set(matching[0], { ...previous, disabled: false, config: { ...previous.config, credentialHome: home } });
} else {
  document.add({ id: 'chatgpt-subscription', config: { credentialHome: home } });
}
const untouched = rows => rows.filter(row => row?.id !== 'chatgpt-subscription');
assert.deepEqual(untouched(document.toJS()), untouched(originalRows));
const lease = await acquireOperationLease(home, 'integrate-web');
try {
  const backup = join(profile, '.chatgpt-backups', `${Date.now()}-${randomUUID()}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    try {
      const source = join(profile, name);
      const entry = await lstat(source);
      assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Refusing non-file profile entry: ${name}`);
      await copyFile(source, join(backup, name), 1);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log(`原生 Web 配置备份：${backup}`);
  const child = spawn(process.execPath, [host.realPath, 'plugin', '--profile', 'web', 'add', '--ignore-scripts', artifact], {
    env: { ...process.env, DSH_HOME: nativeHome }, stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`原生插件安装未完成（${code}）；备份位于 ${backup}`)));
  });
  const updated = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [name, specifier] of Object.entries(originalManifest.dependencies ?? {})) {
    if (name !== 'dsh-chatgpt-subscription') assert.equal(updated.dependencies?.[name], specifier);
  }
  const bundles = updated.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles) && bundles.includes('dsh-chatgpt-subscription'));
  assert.deepEqual(bundles.filter(bundle => bundle !== 'dsh-chatgpt-subscription'),
    originalManifest.dsh.profile.bundles.filter(bundle => bundle !== 'dsh-chatgpt-subscription'));
  await atomicWrite(patchPath, document.toString());
  const installedEntry = join(profile, 'node_modules', 'dsh-chatgpt-subscription', 'dist', 'index.js');
  installCliHostResolution(host.realPath);
  await import(pathToFileURL(installedEntry).href);
  assert.equal(digest(await readFile(host.realPath)), hostBefore, 'Original DSH executable changed.');
  await atomicWrite(join(backup, 'integration.json'), `${JSON.stringify({
    version: installation.version, nativeHome, profile, credentialHome: home, artifact,
    packageSha256: installation.packageSha256, originalHostSha256: hostBefore,
  }, null, 2)}\n`);
  console.log('已接入原生 dsh web；默认模型及其他提供商配置保持原值。');
  console.log('复用现有 ChatGPT 授权；没有复制令牌、重新登录或发送模型请求。');
} finally {
  await lease.release();
}
