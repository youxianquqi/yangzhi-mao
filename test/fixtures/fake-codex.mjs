// Simulates Codex without credentials or networking, including cancelable child processes.
// Explicit message fixtures select outcomes; clues cannot steer fixture control flow.

import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const SESSION_ID = '71a595b0-8995-4ab2-9000-5a27d4c8dd95';
const REQUIRED_PREFIX = [
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks',
    '-c', 'web_search="disabled"', '-c', 'features.view_image=false', 'exec',
];
const REQUIRED_EXEC_ARGS = ['--json', '--skip-git-repo-check', '--ignore-user-config'];
const STREAM_MODES = new Set(['流式成功', '流式失败', '流式挂起', '流式等待', '流式改写']);
const POLL_MS = 10;

await main(process.argv.slice(2));

async function main(args) {
    const resume = args.includes('resume');
    const payload = await readPrompt();
    const expectedArgs = [
        ...REQUIRED_PREFIX, ...(resume ? ['resume'] : []), ...REQUIRED_EXEC_ARGS, ...(resume ? [SESSION_ID] : []), '-',
    ];
    if (args.length !== expectedArgs.length || expectedArgs.some((arg, index) => args[index] !== arg)
        || payload?.character?.name !== '小写' || typeof payload.message !== 'string'
        || (resume && (payload.history !== undefined || (!payload.message.includes('密码是什么')
            && !payload.message.startsWith('回显测试') && !STREAM_MODES.has(payload.message))))) {
        process.exitCode = 2;
        return;
    }
    emit({ type: 'thread.started', thread_id: SESSION_ID });
    emit({ type: 'turn.started' });
    emit({ type: 'item.updated', item: { type: 'agent_message', text: '尚未完成的文本。' } });
    emit({ type: 'item.completed', item: { type: 'command_execution', text: '此工具输出不属于对话。' } });
    if (STREAM_MODES.has(payload.message)) await emitStreamingOutcome(payload.message);
    else emitOutcome(payload, resume);
}

async function readPrompt() {
    let prompt = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) prompt += chunk;
    const [instruction, json, ...extra] = prompt.split('\n');
    if (!instruction.includes('不可信') || !json || extra.length) return null;
    return JSON.parse(json);
}

function emitOutcome(payload, resume) {
    if (payload.message.includes('模拟网络故障')) {
        emitReply('失败前的草稿。');
        emitFailure();
        return;
    }
    if (payload.message.includes('模拟中途结束')) {
        emitReply('缺少完成事件的草稿。');
        return;
    }
    if (payload.message.startsWith('模拟畸形 JSONL')) console.log('{incomplete');
    if (payload.message === '模拟畸形事件') emit({ type: 'item.completed', item: { type: 'agent_message', text: 42 } });

    emitReply(payload.message.startsWith('回显测试') ? JSON.stringify(payload) : resume ? '青竹。' : '我记住了。');
    emit({ type: 'item.completed', item: { type: 'reasoning', text: '此内容不应该成为回复。' } });
    emit({ type: 'turn.completed' });
    if (payload.message === '模拟重复结束') emit({ type: 'turn.completed' });
    if (payload.message === '模拟结束后报错') emit({ type: 'error', message: 'network connection closed' });
}

async function emitStreamingOutcome(mode) {
    if (mode === '流式挂起') await recordFixtureProcesses();
    emitReply('第一段', 'item.updated', 'answer');
    if (mode === '流式挂起') {
        // Keep stdout open until the server cancels the process tree.
        setInterval(() => {}, 1000);
        return;
    }
    if (mode === '流式失败') {
        emitFailure();
        return;
    }
    if (mode === '流式等待') await waitForContinue();
    const final = mode === '流式改写' ? '替换后的最终回答' : '第一段第二段';
    emitReply('第一段', 'item.updated', 'answer');
    emitReply(final, 'item.updated', 'answer');
    emitReply(final, 'item.completed', 'answer');
    emit({ type: 'turn.completed' });
}

async function recordFixtureProcesses() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
    await writeFile('fixture-pid', String(process.pid));
    await writeFile('fixture-descendant-pid', String(child.pid));
}

async function waitForContinue() {
    for (;;) {
        try {
            await access('fixture-continue');
            return;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await wait(POLL_MS);
        }
    }
}

function emitFailure() {
    emit({ type: 'turn.failed', error: { message: 'network connection closed' } });
    process.exitCode = 1;
}

function emitReply(text, type = 'item.completed', id) {
    emit({ type, item: { type: 'agent_message', id, text } });
}

function emit(event) {
    console.log(JSON.stringify(event));
}
