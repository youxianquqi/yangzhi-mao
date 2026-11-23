import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { AppError } from '../errors.js';

const threadIdPattern = /^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|thr_[\da-z_-]+)$/i;
const maxOutputBytes = 4 * 1024 * 1024;

export function resolveCodexCommand(bin = process.env.CODEX_BIN) {
    if (bin) return { file: bin, prefix: [] };
    if (process.platform !== 'win32') return { file: 'codex', prefix: [] };

    const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''));
    // Prefer native executables regardless of the position of the npm shim in PATH.
    for (const dir of paths) {
        const file = join(dir, 'codex.exe');
        if (existsSync(file)) return { file, prefix: [] };
    }
    // On Windows, launching the npm .cmd directly would require a shell.
    for (const dir of paths) {
        const launcher = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (existsSync(launcher)) return { file: process.execPath, prefix: [launcher] };
    }
    return { file: 'codex.exe', prefix: [] };
}

function readTurn(stdout) {
    let id, reply, failed = false, failure, completed = false;
    for (const line of stdout.split(/\r?\n/)) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type === 'thread.started') id = event.thread_id;
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
            if (typeof event.item.text === 'string' && event.item.text.trim()) reply = event.item.text;
        }
        if (event?.type === 'turn.completed') completed = true;
        if (event?.type === 'turn.failed') {
            failed = true;
            failure = typeof event.error?.message === 'string' ? event.error.message : '';
        }
        if (event?.type === 'error' && !failure && typeof event.message === 'string') failure = event.message;
    }
    return { id, reply, failed, failure, completed };
}

function agentError(error, details, sessionId) {
    if (error?.code === 'ENOENT') return new AppError(503, 'CODEX_NOT_FOUND', '找不到 Codex CLI。请安装后运行 codex login。');
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        return new AppError(503, 'CODEX_START_FAILED', '无法启动 Codex CLI，请检查可执行路径和系统权限。');
    }
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return new AppError(502, 'AGENT_OUTPUT_TOO_LARGE', 'Codex 输出过长，未保存这轮消息。');
    }
    if (error?.killed) return new AppError(504, 'AGENT_TIMEOUT', '等待 Codex 回复超时，请重试。');
    if (/not logged in|authentication (?:required|failed)|(?:^|\D)401(?:\D|$)|invalid[_ ]token|invalid api key/i.test(details)) {
        return new AppError(503, 'CODEX_AUTH_REQUIRED', 'Codex 拒绝了当前登录。请检查 codex login status，必要时重新登录。');
    }
    if (sessionId && /no (?:saved )?session|(?:session|thread|rollout).{0,90}(?:not found|does not exist|could not find)/i.test(details)) {
        return new AppError(409, 'AGENT_SESSION_NOT_FOUND', 'Codex 找不到旧会话，请新开会话。');
    }
    if (/rate limit|(?:^|\D)429(?:\D|$)/i.test(details)) {
        return new AppError(429, 'AGENT_RATE_LIMITED', 'Codex 达到使用限额，请稍后再试。');
    }
    if (/network|connection|timed? out|stream disconnected/i.test(details)) {
        return new AppError(502, 'AGENT_UNAVAILABLE', 'Codex 连接失败，请检查网络后重试。');
    }
    return new AppError(502, 'AGENT_INCOMPLETE', 'Codex 未返回完整回复。请确认终端里的 codex exec 可以正常使用。');
}

export function runCodex({ cwd, character, message, sessionId, command = resolveCodexCommand(), timeoutMs = 120_000 }) {
    if (sessionId !== null && (typeof sessionId !== 'string' || !threadIdPattern.test(sessionId))) {
        throw new AppError(409, 'AGENT_INVALID_SESSION', '存档中的 Codex 会话 ID 无效，请新开会话。');
    }
    const args = [...command.prefix,
        '--sandbox', 'read-only', '--ask-for-approval', 'never',
        '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks',
        '-c', 'web_search="disabled"', '-c', 'features.view_image=false', 'exec'];
    if (sessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check', '--ignore-user-config');
    if (sessionId) args.push(sessionId);
    args.push('-');

    const prompt = [
        '这是文字角色对话。按下方角色资料用角色口吻回答，只输出聊天回复，不使用工具、不操作文件。',
        '角色资料：' + JSON.stringify({
            名称: character.name, 设定: character.description, 开场白: character.greeting,
        }),
        '用户消息：\n' + message,
    ].join('\n\n');

    return new Promise((resolve, reject) => {
        const child = execFile(command.file, args, {
            cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: maxOutputBytes, encoding: 'utf8',
        }, (error, stdout, stderr) => {
            const { id, reply, failure, failed, completed } = readTurn(stdout);
            if (!error && !failed && completed && reply && typeof id === 'string' && threadIdPattern.test(id)) {
                if (sessionId && id !== sessionId) {
                    return reject(new AppError(502, 'AGENT_SESSION_MISMATCH', 'Codex 返回了不同的会话 ID，未保存这轮消息。'));
                }
                return resolve({ reply, sessionId: id });
            }
            reject(agentError(error, String(failure ?? '') + '\n' + stderr, sessionId));
        });
        child.stdin.on('error', () => {}); // A closed input pipe is reported by the process callback.
        child.stdin.end(prompt, 'utf8');
    });
}
