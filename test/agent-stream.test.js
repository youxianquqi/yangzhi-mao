// Verifies provider-specific provisional output and authoritative replies using local mocks.
// Weak AGY policy must prevent any preview; Codex rewrites must not append divergent content.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgyStream } from '../plugins/agent-antigravity/agy.js';
import { runCodexStream } from '../src/agents/codex.js';

const character = { name: '小写', description: '角色说明', greeting: '你好' };
const input = { cwd: tmpdir(), character, sessionId: null, context: [] };
const command = fixture => ({ file: process.execPath, prefix: [fileURLToPath(new URL(fixture, import.meta.url))] });

test('Codex 增量只包含回答的新后缀；最终改写以权威回复为准', async () => {
    const deltas = [];
    const run = message => runCodexStream({ ...input, command: command('./fixtures/fake-codex.mjs'), message, onDelta: text => deltas.push(text) });
    const appendOnly = await run('流式成功');
    assert.deepEqual(deltas, ['第一段', '第二段']);
    assert.equal(appendOnly.reply, '第一段第二段');
    deltas.length = 0;
    const revised = await run('流式改写');
    assert.deepEqual(deltas, ['第一段']);
    assert.equal(revised.reply, '替换后的最终回答');
});

test('Codex 在已有部分文本之后仍可失败；失败草稿不是最终回复', async () => {
    const deltas = [];
    await assert.rejects(runCodexStream({
        ...input, command: command('./fixtures/fake-codex.mjs'), message: '流式失败',
        onDelta: text => deltas.push(text),
    }), { code: 'AGENT_UNAVAILABLE' });
    assert.deepEqual(deltas, ['第一段']);
});

test('Antigravity 只转发严格权限下的 agent_response 片段', async () => {
    const deltas = [];
    const run = message => runAgyStream({ ...input, command: command('./fixtures/fake-agy.mjs'), message, onDelta: text => deltas.push(text) });
    const success = await run('流式成功');
    assert.deepEqual(deltas, ['第一段', '第二段']);
    assert.equal(success.reply, '第一段第二段');
    deltas.length = 0;
    await assert.rejects(run('不安全策略'), { code: 'AGY_POLICY' });
    assert.deepEqual(deltas, []);
});
