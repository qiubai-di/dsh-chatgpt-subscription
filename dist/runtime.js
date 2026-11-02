import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
export const HOST_VERSION = '0.2.1-rc.2';
export const PROFILE = 'chatgpt';
export const ROUTE = 'openai-chatgpt';
export const INSTALL_MARKER = 'dsh-chatgpt-subscription';
export class LocalSetupError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LocalSetupError';
    }
}
export function subscriptionHome(explicit) {
    const selected = explicit ?? process.env.DSH_CHATGPT_HOME;
    return resolve(selected || join(homedir(), '.local', 'share', 'dsh-chatgpt-subscription'));
}
export async function assertPrivateHome(home) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new LocalSetupError('UNSAFE_HOME', '订阅数据目录必须是真实目录，不能是符号链接。');
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new LocalSetupError('UNSAFE_HOME', '订阅数据目录必须由当前用户拥有。');
    }
    await chmod(home, 0o700);
}
export async function atomicWrite(path, value, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new LocalSetupError('UNSAFE_FILE', '拒绝写入非普通配置文件。');
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', mode);
        try {
            await file.writeFile(value, 'utf8');
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/** Keep account-changing operations out of an active DSH run, including across CLIs. */
export async function acquireOperationLease(home, operation) {
    const path = join(home, '.operation-lock');
    const nonce = randomUUID();
    return withFileLock(path, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const handle = await open(path, 'wx', 0o600);
                try {
                    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, operation }));
                    await handle.sync();
                }
                catch (error) {
                    await handle.close();
                    await unlink(path);
                    throw error;
                }
                await handle.close();
                let released = false;
                return {
                    async release() {
                        await withFileLock(path, async () => {
                            if (released)
                                return;
                            const held = JSON.parse(await readFile(path, 'utf8'));
                            if (held.nonce !== nonce)
                                throw new LocalSetupError('LOCK_CHANGED', '运行锁已改变，未删除其他进程的锁。');
                            await unlink(path);
                            released = true;
                        });
                    },
                    async trackChild(pid) {
                        if (!Number.isSafeInteger(pid) || pid <= 0)
                            throw new LocalSetupError('INVALID_CHILD', 'DSH 子进程标识无效。');
                        await withFileLock(path, async () => {
                            const held = JSON.parse(await readFile(path, 'utf8'));
                            if (released || held.nonce !== nonce)
                                throw new LocalSetupError('LOCK_CHANGED', '运行锁已改变，未更新其他进程的锁。');
                            await atomicWrite(path, JSON.stringify({ pid: process.pid, childPid: pid, nonce, operation }));
                        });
                    },
                };
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink())
                throw new LocalSetupError('UNSAFE_LOCK', '专用运行锁不是普通文件。');
            let existing;
            try {
                existing = JSON.parse(await readFile(path, 'utf8'));
            }
            catch {
                throw new LocalSetupError('INVALID_LOCK', '专用运行锁损坏；请确认没有运行中的 DSH 后检查该文件。');
            }
            if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.nonce !== 'string') {
                throw new LocalSetupError('INVALID_LOCK', '专用运行锁格式无效。');
            }
            let alive = false;
            for (const pid of [existing.pid, existing.childPid]) {
                if (pid === undefined)
                    continue;
                if (!Number.isSafeInteger(pid) || pid <= 0)
                    throw new LocalSetupError('INVALID_LOCK', '专用运行锁的进程信息无效。');
                try {
                    process.kill(pid, 0);
                    alive = true;
                }
                catch (error) {
                    if (error.code === 'EPERM')
                        alive = true;
                    else if (error.code !== 'ESRCH')
                        throw error;
                }
            }
            if (alive)
                throw new LocalSetupError('SESSION_BUSY', '此订阅配置正在运行或授权。请先关闭对应的 DSH/登录进程，再切换或退出账号。');
            const current = await lstat(path);
            if (current.ino !== info.ino || current.dev !== info.dev)
                continue;
            await unlink(path);
        }
        throw new LocalSetupError('SESSION_BUSY', '专用运行锁正在变化，请稍后重试。');
    });
}
export async function readInstallation(home) {
    let value;
    try {
        value = JSON.parse(await readFile(join(home, 'installation.json'), 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new LocalSetupError('NOT_INSTALLED', '尚未部署专用配置。请先运行本项目的本地安装脚本。');
        }
        throw new LocalSetupError('INVALID_INSTALLATION', '本地安装记录无法读取。');
    }
    if (!value || typeof value !== 'object')
        throw new LocalSetupError('INVALID_INSTALLATION', '安装记录格式无效。');
    const record = value;
    if (record.marker !== INSTALL_MARKER || record.dshVersion !== HOST_VERSION
        || typeof record.dshExecutable !== 'string' || !isAbsolute(record.dshExecutable)
        || typeof record.dshRealPath !== 'string' || typeof record.version !== 'string') {
        throw new LocalSetupError('INVALID_INSTALLATION', '安装记录与此订阅配置不匹配。');
    }
    return record;
}
export async function assertHost(executable) {
    const realPath = await realpath(executable);
    const packagePath = resolve(dirname(realPath), '..', 'package.json');
    let metadata;
    try {
        metadata = JSON.parse(await readFile(packagePath, 'utf8'));
    }
    catch {
        throw new LocalSetupError('INVALID_HOST', '无法核对 DSH 安装包，未启动。');
    }
    if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== HOST_VERSION) {
        throw new LocalSetupError('HOST_VERSION_CHANGED', `此配置只针对 DSH ${HOST_VERSION} 构建；宿主改变后需要重新检查适配。`);
    }
    return { executable: resolve(executable), realPath };
}
export async function findDsh(explicit) {
    if (explicit)
        return (await assertHost(resolve(explicit))).executable;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory)
            continue;
        const candidate = join(directory, 'dsh');
        try {
            await access(candidate, constants.X_OK);
        }
        catch {
            continue;
        }
        return (await assertHost(candidate)).executable;
    }
    throw new LocalSetupError('HOST_NOT_FOUND', '未找到 DSH 命令。请用 --dsh 指定原版 dsh。');
}
export async function selectDefaultModel(home, modelIds) {
    if (modelIds.length === 0)
        throw new LocalSetupError('NO_SUPPORTED_MODELS', '账号目录中没有此适配器支持的 GPT 模型。');
    const path = join(home, 'profiles', PROFILE, 'cordis.patch.yml');
    const document = parseDocument(await readFile(path, 'utf8'));
    if (document.errors.length > 0 || !Array.isArray(document.toJS())) {
        throw new LocalSetupError('INVALID_PROFILE', '专用 profile 的配置格式无效，未覆盖原文件。');
    }
    const rows = document.toJS();
    const index = rows.findIndex((row) => row?.id === 'agent-default-model');
    const previous = index < 0 ? undefined : rows[index]?.config;
    const model = previous?.provider === ROUTE && previous.model && modelIds.includes(previous.model)
        ? previous.model : modelIds[0];
    const row = { id: 'agent-default-model', config: { provider: ROUTE, model } };
    if (index < 0)
        document.add(row);
    else
        document.set(index, row);
    await atomicWrite(path, document.toString());
    return model;
}
//# sourceMappingURL=runtime.js.map