import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse } from 'yaml';
import {
  acquireOperationLease, atomicWrite, LocalSetupError, PROFILE, ROUTE, selectDefaultModel, readInstallation,
} from '../src/runtime.js';

async function temporaryHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-runtime-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('an empty writer lock explains the login failure without deleting uncertain state', async t => {
  const home = await temporaryHome(t);
  const path = join(home, '.operation-lock.lock');
  await writeFile(path, '');
  await assert.rejects(acquireOperationLease(home, 'login'), error => {
    assert.ok(error instanceof LocalSetupError);
    assert.equal(error.code, 'OPERATION_LOCK_TIMEOUT');
    assert.match(error.message, /\.operation-lock\.lock/);
    assert.match(error.message, /DSH/);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), '');
  await rm(path);
  const lease = await acquireOperationLease(home, 'login');
  await lease.release();
});

test('login can read an existing installation record after a host upgrade', async t => {
  const home = await temporaryHome(t);
  const record = { marker: 'dsh-chatgpt-subscription', version: '0.1.8',
    dshVersion: '0.2.1-rc.2', dshExecutable: join(home, 'old-dsh.js'), dshRealPath: join(home, 'old-dsh.js') };
  await writeFile(join(home, 'installation.json'), JSON.stringify(record));
  assert.deepEqual(await readInstallation(home), record);
});

function setupError(code: string): (error: unknown) => boolean {
  return error => error instanceof LocalSetupError && error.code === code;
}

async function profilePath(home: string): Promise<string> {
  const directory = join(home, 'profiles', PROFILE);
  await mkdir(directory, { recursive: true });
  return join(directory, 'cordis.patch.yml');
}

async function deadChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid);
  await once(child, 'close');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}

async function liveChild(t: TestContext): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  assert.ok(child.pid);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  return child as ChildProcess & { pid: number };
}

interface LockReply {
  kind: 'ready' | 'acquired' | 'released' | 'rejected';
  code?: string;
}

function childReply(child: ChildProcess): Promise<LockReply> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function onMessage(value: LockReply): void { cleanup(); resolve(value); }
    function onError(error: Error): void { cleanup(); reject(error); }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      reject(new Error(`Lock test child exited before replying (${code ?? signal}).`));
    }
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function lockContender(t: TestContext, home: string): Promise<ChildProcess> {
  const source = `
    const { acquireOperationLease } = await import(process.argv[2]);
    let lease;
    process.on('message', async ({ action }) => {
      try {
        if (action === 'acquire') {
          lease = await acquireOperationLease(process.argv[1], 'cross-process-test');
          process.send({ kind: 'acquired' });
        } else if (action === 'release') {
          await lease.release();
          lease = undefined;
          process.send({ kind: 'released' });
        }
      } catch (error) {
        process.send({ kind: 'rejected', code: error.code });
      }
    });
    process.send({ kind: 'ready' });
  `;
  const child = spawn(process.execPath, [
    '--input-type=module', '-e', source, home, new URL('../src/runtime.js', import.meta.url).href,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  assert.deepEqual(await childReply(child), { kind: 'ready' });
  return child;
}

function command(child: ChildProcess, action: 'acquire' | 'release'): Promise<LockReply> {
  const reply = childReply(child);
  child.send({ action });
  return reply;
}

test('independent login and run calls share one operation lease', async t => {
  const home = await temporaryHome(t);
  const login = await acquireOperationLease(home, 'login');
  const held = await readFile(join(home, '.operation-lock'), 'utf8');
  await assert.rejects(acquireOperationLease(home, 'run'), setupError('SESSION_BUSY'));
  assert.equal(await readFile(join(home, '.operation-lock'), 'utf8'), held);

  await login.release();
  const run = await acquireOperationLease(home, 'run');
  await assert.rejects(acquireOperationLease(home, 'login'), setupError('SESSION_BUSY'));
  await run.release();
});

test('release is idempotent and cannot remove a later operation lease', async t => {
  const home = await temporaryHome(t);
  const first = await acquireOperationLease(home, 'login');
  await first.release();
  await first.release();
  const next = await acquireOperationLease(home, 'run');
  await first.release();
  await assert.rejects(acquireOperationLease(home, 'logout'), setupError('SESSION_BUSY'));
  await next.release();
  await assert.rejects(lstat(join(home, '.operation-lock')), { code: 'ENOENT' });
});

test('a terminated owner allows stale operation lock recovery', { timeout: 10_000 }, async t => {
  const home = await temporaryHome(t);
  const path = join(home, '.operation-lock');
  await writeFile(path, JSON.stringify({ pid: await deadChildPid(), nonce: 'previous-owner', operation: 'login' }));
  const recovered = await acquireOperationLease(home, 'run');
  const current = JSON.parse(await readFile(path, 'utf8')) as { pid: number; nonce: string; operation: string };
  assert.equal(current.pid, process.pid);
  assert.equal(current.operation, 'run');
  assert.notEqual(current.nonce, 'previous-owner');
  await recovered.release();
});

test('cross-process stale-lock contenders admit only one holder until it releases', { timeout: 15_000 }, async t => {
  const home = await temporaryHome(t);
  const path = join(home, '.operation-lock');
  await writeFile(path, JSON.stringify({ pid: await deadChildPid(), nonce: 'dead-owner', operation: 'run' }));

  // Each contender has imported runtime.ts and installed its IPC handler before
  // the parent releases this start barrier. They keep running after their reply.
  const contenders = await Promise.all(Array.from({ length: 3 }, () => lockContender(t, home)));
  const results = await Promise.all(contenders.map(child => command(child, 'acquire')));
  const winnerIndices = results.flatMap((reply, index) => reply.kind === 'acquired' ? [index] : []);
  assert.equal(winnerIndices.length, 1, JSON.stringify(results));
  const winnerIndex = winnerIndices[0]!;
  const winner = contenders[winnerIndex]!;
  const losers = contenders.filter((_, index) => index !== winnerIndex);
  assert.deepEqual(results.filter((_, index) => index !== winnerIndex), [
    { kind: 'rejected', code: 'SESSION_BUSY' },
    { kind: 'rejected', code: 'SESSION_BUSY' },
  ]);
  const held = await readFile(path, 'utf8');
  assert.equal((JSON.parse(held) as { pid: number }).pid, winner.pid);
  assert.deepEqual(await Promise.all(losers.map(child => command(child, 'acquire'))), [
    { kind: 'rejected', code: 'SESSION_BUSY' },
    { kind: 'rejected', code: 'SESSION_BUSY' },
  ]);
  assert.equal(await readFile(path, 'utf8'), held);

  assert.deepEqual(await command(winner, 'release'), { kind: 'released' });
  assert.deepEqual(await command(losers[0]!, 'acquire'), { kind: 'acquired' });
  assert.equal((JSON.parse(await readFile(path, 'utf8')) as { pid: number }).pid, losers[0]!.pid);
  assert.deepEqual(await command(losers[0]!, 'release'), { kind: 'released' });
});

test('a live tracked child keeps a terminated owner lock busy', { timeout: 10_000 }, async t => {
  const home = await temporaryHome(t);
  const child = await liveChild(t);
  const path = join(home, '.operation-lock');
  const held = JSON.stringify({
    pid: await deadChildPid(), childPid: child.pid, nonce: 'active-dsh-child', operation: 'run',
  });
  await writeFile(path, held);
  await assert.rejects(acquireOperationLease(home, 'login'), setupError('SESSION_BUSY'));
  assert.equal(await readFile(path, 'utf8'), held);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test('tracking a child preserves the current operation lease', { timeout: 10_000 }, async t => {
  const home = await temporaryHome(t);
  const child = await liveChild(t);
  const lease = await acquireOperationLease(home, 'run');
  await lease.trackChild(child.pid);
  await assert.rejects(acquireOperationLease(home, 'login'), setupError('SESSION_BUSY'));
  await assert.rejects(lease.trackChild(0), setupError('INVALID_CHILD'));
  await lease.release();
});

test('model selection preserves other YAML rows, comments, and an available user choice', async t => {
  const home = await temporaryHome(t);
  const path = await profilePath(home);
  const original = [
    '# User-owned profile settings',
    '- id: user-terminal',
    '  config:',
    '    label: "keep: this exact value"',
    '    colors: [blue, green]',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${ROUTE}`,
    '    model: gpt-user-choice',
    '- id: user-history',
    '  config:',
    '    enabled: false',
    '',
  ].join('\n');
  await writeFile(path, original);
  assert.equal(await selectDefaultModel(home, ['gpt-first-listed', 'gpt-user-choice']), 'gpt-user-choice');
  const updated = await readFile(path, 'utf8');
  const before = parse(original) as Array<{ id: string }>;
  const after = parse(updated) as Array<{ id: string }>;
  assert.deepEqual(after.filter(row => row.id !== 'agent-default-model'), before.filter(row => row.id !== 'agent-default-model'));
  assert.match(updated, /# User-owned profile settings/);
  assert.deepEqual(after.find(row => row.id === 'agent-default-model'), {
    id: 'agent-default-model', config: { provider: ROUTE, model: 'gpt-user-choice' },
  });
});

test('model selection replaces unavailable defaults and appends absent defaults', async t => {
  for (const initial of [
    '- id: user-history\n  config: { enabled: true }\n',
    '- id: user-history\n  config: { enabled: true }\n- id: agent-default-model\n  config: { provider: openai-chatgpt, model: unavailable }\n',
  ]) {
    const home = await temporaryHome(t);
    const path = await profilePath(home);
    await writeFile(path, initial);
    assert.equal(await selectDefaultModel(home, ['gpt-account-model']), 'gpt-account-model');
    const rows = parse(await readFile(path, 'utf8')) as Array<{ id: string }>;
    assert.equal(rows.filter(row => row.id === 'agent-default-model').length, 1);
    assert.deepEqual(rows.find(row => row.id === 'user-history'), { id: 'user-history', config: { enabled: true } });
    assert.deepEqual(rows.find(row => row.id === 'agent-default-model'), {
      id: 'agent-default-model', config: { provider: ROUTE, model: 'gpt-account-model' },
    });
  }
});

test('invalid profile YAML is rejected without changing the file', async t => {
  for (const invalid of ['- id: [unterminated\n', 'not-a-profile-list: true\n']) {
    const home = await temporaryHome(t);
    const path = await profilePath(home);
    await writeFile(path, invalid);
    await assert.rejects(selectDefaultModel(home, ['gpt-account-model']), setupError('INVALID_PROFILE'));
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
});

test('atomicWrite rejects a symbolic-link target and preserves its referent', async t => {
  const home = await temporaryHome(t);
  const target = join(home, 'user-settings.yml');
  const link = join(home, 'settings-link.yml');
  await writeFile(target, 'untouched user content\n');
  await symlink(target, link);
  await assert.rejects(atomicWrite(link, 'replacement\n'), setupError('UNSAFE_FILE'));
  assert.equal(await readFile(target, 'utf8'), 'untouched user content\n');
  assert.ok((await lstat(link)).isSymbolicLink());
});
