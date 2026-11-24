// A real settings/role/thread/plugin integration using a local, credential-free model mock.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../server.js';
import { contentType, delta, frame } from './fixtures/mock-openai.mjs';

test('默认线保留旧角色笔记；两条线独立，DeepSeek / MiniMax 每次读取最新已保存线索', async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-thread-clues-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'story-clues': { enabled: true } } }));
    const upstream = [];
    const { app, kernel } = await createRuntime({
        dataDir, env: {}, logger: { error() {} },
        modelFetch: async (_url, init) => {
            upstream.push(JSON.parse(init.body).messages[0].content);
            return new Response(frame(delta('已记下。')) + frame(delta(undefined, 'stop')) + frame('[DONE]'), { headers: contentType });
        },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        });
        await kernel.dispose();
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function api(path, method, data) {
        const res = await fetch(origin + '/api' + path, {
            method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
        });
        assert.ok(res.ok, res.status + ' ' + path);
        return res.json();
    }
    const role = await api('/characters', 'POST', { name: '书房猫', description: '调查线索。' });
    const roles = '/characters/' + role.id;
    const legacyRoute = '/plugins/story-clues/notes/' + role.id;
    const thread = await api(roles + '/threads', 'POST', { name: '镜厅' });
    const threadRoute = '/plugins/story-clues/thread-notes/' + thread.id;
    const messages = roles + '/threads/' + thread.id + '/messages';
    await api(legacyRoute, 'PUT', { clues: ['旧角色线索'], summary: '旧默认线' });
    assert.deepEqual(await api(threadRoute), { clues: [], summary: '' });
    assert.equal((await api(legacyRoute)).summary, '旧默认线');

    for (const preset of ['deepseek', 'minimax']) {
        await api('/settings/model', 'PUT', { preset, apiKey: 'fixture-not-a-token' });
        const initialNote = preset + ' 雨伞';
        const revisedNote = preset + ' 红灯';
        await api(threadRoute, 'PUT', { clues: ['镜厅线索'], summary: initialNote });
        const first = await api(messages, 'POST', { message: '第一轮' });
        assert.match(upstream.at(-1), new RegExp(initialNote));
        assert.doesNotMatch(upstream.at(-1), /旧角色线索/);
        await api(threadRoute, 'PUT', { clues: ['更新线索'], summary: revisedNote });
        const second = await api(messages, 'POST', { message: '第二轮' });
        assert.equal(first.sessionId, second.sessionId);
        assert.match(upstream.at(-1), new RegExp(revisedNote));
        assert.match(upstream.at(-1), /更新线索/);
        assert.doesNotMatch(upstream.at(-1), new RegExp(initialNote));
        await api(roles + '/threads/' + role.id + '/messages', 'POST', { message: '默认线对话' });
        assert.match(upstream.at(-1), /旧角色线索/);
        assert.doesNotMatch(upstream.at(-1), /更新线索/);
    }
});
