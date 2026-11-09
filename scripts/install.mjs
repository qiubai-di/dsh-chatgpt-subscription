#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireOperationLease, assertHost, assertPrivateHome, atomicWrite, findDsh, HOST_VERSION, INSTALL_MARKER, PROFILE, ROUTE, subscriptionHome } from '../dist/runtime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  home: { type: 'string' }, 'bin-dir': { type: 'string' }, dsh: { type: 'string' },
} });
const home = subscriptionHome(values.home);
const binDir = resolve(values['bin-dir'] ?? join(homedir(), '.local', 'bin'));
const markerPath = join(home, 'installation.json');
const pendingPath = join(home, 'installation-pending.json');
const profile = join(home, 'profiles', PROFILE);
const packagePath = join(profile, 'package.json');
const launcherPath = join(binDir, 'dsh-chatgpt');
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function command(executable, args, cwd, env = process.env) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (data) => { stdout += data; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`安装步骤未完成：${executable}（${code}）`)));
  });
  return stdout;
}

// Check every existing destination before creating files or installing packages.
const existingMarker = await readOptional(markerPath);
const pendingMarker = await readOptional(pendingPath);
try {
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('数据目录不能是符号链接或普通文件。');
  if ((!existingMarker || JSON.parse(existingMarker).marker !== INSTALL_MARKER)
    && (!pendingMarker || JSON.parse(pendingMarker).marker !== INSTALL_MARKER)) {
    throw new Error('目标目录已存在且不是此插件管理的安装；请选择另一个 --home。');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const existingLauncher = await readOptional(launcherPath);
if (existingLauncher && !existingLauncher.includes(`# managed-by: ${INSTALL_MARKER}\n`)) {
  throw new Error('目标命令已存在且不属于此安装，未覆盖。请另选 --bin-dir。');
}
const dsh = await findDsh(values.dsh);
const host = await assertHost(dsh);
const before = {
  bin: digest(await readFile(host.realPath)),
  manifest: digest(await readFile(resolve(dirname(host.realPath), '..', 'package.json'))),
};
for (const relative of ['dist/index.js', 'dist/cli.js', 'README.md', 'LICENSE', 'package-lock.json']) {
  await readFile(join(root, relative));
}
const artifactDir = join(root, 'artifacts');
await mkdir(artifactDir, { recursive: true });
const packOutput = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDir, '--cache', join(tmpdir(), 'dsh-chatgpt-npm-cache')], root);
const packed = JSON.parse(packOutput);
// npm 12 keys JSON output by package name; npm 11 returns an array.
const packedEntry = Array.isArray(packed) ? packed[0] : packed[packageInfo.name];
if (typeof packedEntry?.filename !== 'string' || packedEntry.filename !== `${packageInfo.name}-${packageInfo.version}.tgz`) {
  throw new Error('无法读取安装包结果。');
}
const archive = join(artifactDir, packedEntry.filename);
const archiveBytes = await readFile(archive);
const archiveHash = digest(archiveBytes);
await assertPrivateHome(home);
const lease = await acquireOperationLease(home, 'install');
try {
  await atomicWrite(pendingPath, `${JSON.stringify({ marker: INSTALL_MARKER, version: packageInfo.version })}\n`);
  const releaseDir = join(home, 'releases');
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  const installedArchive = join(releaseDir, `${packageInfo.version}-${archiveHash.slice(0, 16)}.tgz`);
  try {
    await copyFile(archive, installedArchive, 1);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (digest(await readFile(installedArchive)) !== archiveHash) throw new Error('目标安装包校验失败。');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const oldManifest = await readOptional(packagePath);
  if (oldManifest && !existingMarker && !pendingMarker) throw new Error('目标 profile 已存在，未覆盖。');
  if (existingMarker) {
    const backupDir = join(home, 'installation-backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const suffix = `${Date.now()}`;
    await atomicWrite(join(backupDir, `${suffix}-installation.json`), existingMarker);
    if (oldManifest) await atomicWrite(join(backupDir, `${suffix}-package.json`), oldManifest);
  }
  const manifest = {
    name: 'dsh-chatgpt-local-profile', private: true, type: 'module',
    dependencies: { 'dsh-chatgpt-subscription': `file:${installedArchive}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-chatgpt-subscription'] } },
  };
  await atomicWrite(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const patchPath = join(profile, 'cordis.patch.yml');
  if (await readOptional(patchPath) === undefined) {
    await atomicWrite(patchPath, `${JSON.stringify([{ id: 'agent-default-model', config: { provider: ROUTE, model: '__sign_in_required__' } }], null, 2)}\n`);
  }
  // The native manager connects host-provided peers; this is package maintenance,
  // not application startup. Only independent runtime libraries are bundled.
  await command(process.execPath, [host.realPath, 'plugin', '--profile', PROFILE, 'add', '--ignore-scripts', installedArchive],
    profile, { ...process.env, DSH_HOME: home });
  const installedPackage = join(profile, 'node_modules', 'dsh-chatgpt-subscription');
  const targetManifest = JSON.parse(await readFile(join(installedPackage, 'package.json'), 'utf8'));
  if (targetManifest.version !== packageInfo.version) throw new Error('安装的插件版本不匹配。');
  // Only load modules and render help: no Context, DSH session, or account access.
  await command(process.execPath, ['--input-type=module', '-e', 'const { installCliHostResolution } = await import(process.argv[1]); installCliHostResolution(process.argv[2]); await import(process.argv[3])',
    pathToFileURL(join(installedPackage, 'dist', 'cli-host-resolution.js')).href, host.realPath,
    pathToFileURL(join(installedPackage, 'dist', 'index.js')).href], profile);
  await command(process.execPath, [join(installedPackage, 'dist', 'cli.js'), 'help'], profile);
  const after = {
    bin: digest(await readFile(host.realPath)),
    manifest: digest(await readFile(resolve(dirname(host.realPath), '..', 'package.json'))),
  };
  if (before.bin !== after.bin || before.manifest !== after.manifest) throw new Error('原版 DSH 文件发生变化，停止发布专用命令。');
  const installation = {
    marker: INSTALL_MARKER, version: packageInfo.version,
    dshExecutable: host.executable, dshRealPath: host.realPath, dshVersion: HOST_VERSION,
    packageSha256: archiveHash, installedAt: new Date().toISOString(),
    originalHostHashes: after,
  };
  await atomicWrite(markerPath, `${JSON.stringify(installation, null, 2)}\n`);
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  const launcher = `#!/bin/sh\n# managed-by: ${INSTALL_MARKER}\nexport DSH_CHATGPT_HOME=${quote(home)}\nexec ${quote(process.execPath)} ${quote(join(installedPackage, 'dist', 'cli.js'))} "$@"\n`;
  await atomicWrite(launcherPath, launcher, 0o700);
  await chmod(launcherPath, 0o700);
  await rm(pendingPath);
  console.log(`已安装专用命令：${launcherPath}`);
  console.log(`插件安装包 SHA256：${archiveHash}`);
  console.log(`原版 dsh ${HOST_VERSION} 文件保持一致。`);
  console.log('没有启动 DSH、登录 ChatGPT 或发送模型请求。');
} finally {
  await lease.release();
}
