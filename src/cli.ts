#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { installCliHostResolution } from './cli-host-resolution.js';
import { acquireOperationLease, assertHost, assertPrivateHome, LocalSetupError, PROFILE, readInstallation, selectDefaultModel, subscriptionHome, type OperationLease } from './runtime.js';

const VERSION = '0.2.0';
const HELP = `DSH · ChatGPT 订阅

用法：dsh-chatgpt <命令> [--home <专用数据目录>] [--dsh <当前 DSH 命令>]

  login     登录 ChatGPT 订阅，并读取账号可用模型
  status    查看本地登录状态；不会访问网络
  models    刷新账号可用模型，不发送推理请求
  run       使用专用配置启动 DSH
  logout    撤销此应用的授权并退出
  help      显示本说明

GPT 由 DSH 作为主模型使用。此配置不会回退到 API key 计费。
`;

function abortOnSignals(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('操作已取消。'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return {
    signal: controller.signal,
    dispose() {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    },
  };
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({ args: arguments_, allowPositionals: true, options: {
    home: { type: 'string' }, dsh: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
  } });
  if (parsed.values.version) { console.log(VERSION); return; }
  const command = parsed.positionals[0] ?? 'help';
  if (parsed.values.help || command === 'help') { console.log(HELP); return; }
  if (!['login', 'status', 'models', 'run', 'logout'].includes(command) || parsed.positionals.length > 1) {
    throw new LocalSetupError('INVALID_COMMAND', '命令无效。运行 dsh-chatgpt help 查看用法。');
  }
  const home = subscriptionHome(parsed.values.home);
  const installation = await readInstallation(home);
  await assertPrivateHome(home);
  let cliHost: string;
  try { cliHost = realpathSync(parsed.values.dsh ?? installation.dshRealPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LocalSetupError('HOST_NOT_FOUND', '安装记录中的 DSH 已不存在。请用 --dsh 指定当前 DSH 命令，或重新运行本地安装器；已有授权无需删除。');
    }
    throw error;
  }
  if (parsed.values.dsh) await assertHost(cliHost);
  installCliHostResolution(cliHost);
  const { openSubscriptionStore } = await import('./dsh-store.js');
  const { manager, dispose } = await openSubscriptionStore(home);
  const cancellation = abortOnSignals();
  let lease: OperationLease | undefined;
  try {
    if (command === 'status') {
      const status = await manager.status();
      console.log(`DSH ChatGPT 订阅 ${VERSION}`);
      console.log(status.signedIn ? '登录：已保存授权' : '登录：未登录或需要重新授权');
      if (status.email) console.log(`账号：${status.email}`);
      console.log(`可用模型：${status.modelCount}`);
      console.log('真实 GPT 可用性需在用户授权后另行验证。');
      return;
    }
    if (command === 'run' || command === 'login' || command === 'logout') {
      lease = await acquireOperationLease(home, command);
    }
    if (command === 'logout') {
      if (!(await manager.status()).signedIn) {
        console.log('当前未登录，无需撤销授权。');
        return;
      }
      await manager.logout({ signal: cancellation.signal });
      console.log('已撤销此应用的授权并退出。');
      return;
    }
    if (command === 'login') {
      console.log('请在浏览器中完成 ChatGPT 授权；按 Ctrl+C 取消。');
      await manager.login({
        notify(event) {
          if (event.type === 'auth_url') console.log(`\n${event.url}\n`);
          else if (event.type === 'info' || event.type === 'progress') console.log(event.message);
        },
      }, { signal: cancellation.signal });
      console.log('授权已保存。正在读取账号模型目录，不发送推理请求。');
    }
    if (command === 'models' || command === 'login') {
      const models = await manager.refreshModels({ signal: cancellation.signal });
      const selected = await selectDefaultModel(home, models.map((model) => model.id));
      console.log(`已选择默认模型：${selected}`);
      console.log('运行 dsh-chatgpt run 启动专用 DSH。');
      return;
    }
    const status = await manager.status();
    if (!status.signedIn || status.needsLogin) {
      throw new LocalSetupError('LOGIN_REQUIRED', '请先运行 dsh-chatgpt login 完成此应用的订阅授权。');
    }
    if (status.modelCount === 0) throw new LocalSetupError('MODELS_REQUIRED', '请先运行 dsh-chatgpt models 读取账号模型。');
    await selectDefaultModel(home, status.models.map((model) => model.id));
    const host = await assertHost(parsed.values.dsh ?? installation.dshExecutable);
    if (!parsed.values.dsh && host.realPath !== installation.dshRealPath) {
      throw new LocalSetupError('HOST_PATH_CHANGED', 'DSH 安装路径已改变，请重新运行本地安装脚本。');
    }
    await dispose();
    cancellation.dispose();
    const environment: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    const child = spawn(process.execPath, [host.realPath, '--profile', PROFILE, '--no-open'], {
      stdio: 'inherit', env: environment,
    });
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve();
        else reject(new LocalSetupError('HOST_EXIT', `DSH 已退出（${code ?? signal ?? 'unknown'}）。`));
      });
    });
    // Signal or spawn errors can arrive while the child PID is being recorded.
    // The original promise is still awaited below and preserves its failure.
    void completion.catch(() => undefined);
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTerminate = () => child.kill('SIGTERM');
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);
    try {
      if (child.pid) {
        try { await lease?.trackChild(child.pid); }
        catch (error) { child.kill('SIGTERM'); await completion; throw error; }
      }
      await completion;
    } finally {
      process.removeListener('SIGINT', forwardInterrupt);
      process.removeListener('SIGTERM', forwardTerminate);
    }
  } finally {
    cancellation.dispose();
    try { await dispose(); }
    finally { await lease?.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Domain errors carry deliberate human-readable messages. Never stringify a
    // credential-bearing error object or print raw provider response payloads.
    if (error instanceof Error && (error.name === 'SiwcError' || error.name === 'SubscriptionStateError' || error instanceof LocalSetupError)) {
      console.error(error.message);
    } else if ((error as NodeJS.ErrnoException)?.code === 'EACCES') {
      console.error('没有权限访问专用订阅目录。');
    } else if (error instanceof Error && error.name === 'AbortError') {
      console.error('操作已取消。');
    } else if (typeof (error as NodeJS.ErrnoException)?.code === 'string') {
      console.error(`操作未完成（${(error as NodeJS.ErrnoException).code}）。运行 dsh-chatgpt help 查看命令。`);
    } else {
      console.error(`操作未完成（${error instanceof Error ? error.name : 'unknown error'}）。`);
    }
    process.exitCode = 1;
  });
}
