// Exercises notes, turn admission, and storage compatibility over local HTTP.
// All Agent calls use in-process fakes; tests never authenticate or reach a model.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../server.js';
import { LIMITS } from '../src/config.js';

const sessionId = 'offline-session';
const notes = { clues: ['蓝灯亮着', '窗边有猫毛'], summary: '先查书房。' };
const profile = { name: '小猫', description: '安静地调查书房。' };
const api = '/api/characters';
const notesPath = role => '/api/plugins/story-clues/notes/' + role.split('/').at(-1);
const offlineReply = { reply: '继续调查。', sessionId };

test('笔记可读写，只在新会话首轮交给 Agent，重置及编辑角色不清空笔记', async t => {
    const turns = [];
    const app = await setup(t, async request => {
        turns.push(structuredClone({ ...request, signal: undefined }));
        request.context[0]?.data.clues.push('不应污染存档');
        return offlineReply;
    });
    const role = await app.create();
    assert.deepEqual((await app.request(notesPath(role))).body, { clues: [], summary: '' });
    const saved = await app.request(notesPath(role), 'PUT', { clues: [' 蓝灯亮着 ', '窗边有猫毛'], summary: ' 先查书房。 ' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, notes);
    assert.equal('notes' in (await app.request(role, 'PUT', profile)).body, false);

    assert.equal((await app.send(role)).status, 200);
    assert.deepEqual(turns[0].context, [{ pluginId: 'story-clues', data: notes }]);
    assert.equal(turns[0].character.description, profile.description);
    assert.equal(turns[0].sessionId, null);
    assert.equal((await app.send(role)).status, 200);
    assert.equal(turns[1].sessionId, sessionId);
    assert.deepEqual(turns[1].context, []);

    const reset = await app.request(role + '/session', 'DELETE');
    assert.deepEqual(reset.body.messages, []);
    assert.equal((await app.send(role)).status, 200);
    assert.deepEqual(turns[2].context, [{ pluginId: 'story-clues', data: notes }]);
    assert.deepEqual((await app.request(notesPath(role))).body, notes);
});

test('非法线索、超限内容、错误 Content-Type 和异源写入不修改笔记', async t => {
    const app = await setup(t);
    const role = await app.create();
    const route = notesPath(role);
    assert.equal((await app.request(route, 'PUT', notes)).status, 200);
    for (const invalid of [
        { clues: 'not-an-array', summary: '' }, { clues: [], summary: null },
        { clues: ['  '], summary: '' }, { clues: ['两\n行'], summary: '' },
        { clues: ['甲'.repeat(241)], summary: '' },
        { clues: Array(25).fill('甲'), summary: '' },
        { clues: [], summary: '甲'.repeat(2001) },
        { clues: [], summary: '', unexpected: true },
    ]) {
        const result = await app.request(route, 'PUT', invalid);
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'INVALID_INPUT');
    }
    const crossSite = await app.request(route, 'PUT', { clues: [], summary: '' }, { Origin: 'https://example.com' });
    assert.equal(crossSite.status, 403);
    const wrongType = await app.request(route, 'PUT', notes, { 'Content-Type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    const oversized = await app.request(route, 'PUT', { clues: [], summary: '甲'.repeat(30_000) });
    assert.equal(oversized.status, 413);
    assert.deepEqual((await app.request(route)).body, notes);
});

test('读取旧笔记不重写角色；损坏的插件字段不拖垮核心角色读取', async t => {
    const app = await setup(t);
    const role = await app.create();
    const path = app.recordPath(role);
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    delete legacy.notes;
    const original = JSON.stringify(legacy);
    await writeFile(path, original, 'utf8');
    assert.deepEqual((await app.request(notesPath(role))).body, { clues: [], summary: '' });
    assert.equal(await readFile(path, 'utf8'), original);

    await writeFile(path, JSON.stringify({ ...legacy, notes }), 'utf8');
    assert.deepEqual((await app.request(notesPath(role))).body, notes);
    assert.equal('notes' in (await app.request(role)).body, false);
    await app.request(role, 'PUT', profile);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).notes, notes);
    await writeFile(path, JSON.stringify({ ...legacy, notes: { clues: [1], summary: '' } }), 'utf8');
    assert.deepEqual((await app.request(notesPath(role))).body, { clues: [], summary: '' });
    assert.equal((await app.request(role)).status, 200);
});

test('历史容量在调用 Agent 前拦截，旧超额历史可读取并重置', async t => {
    let calls = 0;
    const app = await setup(t, async () => { calls++; return offlineReply; }, false);
    const role = await app.create();
    const path = app.recordPath(role);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.messages = makeMessages(LIMITS.historyMessages - LIMITS.turnMessages);
    await writeFile(path, JSON.stringify(record), 'utf8');
    const filled = await app.send(role);
    assert.equal(filled.body.messages.length, LIMITS.historyMessages);
    const full = await readFile(path, 'utf8');
    const rejected = await app.send(role);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'HISTORY_LIMIT');
    assert.equal(calls, 1);
    assert.equal(await readFile(path, 'utf8'), full);

    record.messages = makeMessages(LIMITS.historyMessages + 1);
    await writeFile(path, JSON.stringify(record), 'utf8');
    assert.equal((await app.request(role)).body.messages.length, LIMITS.historyMessages + 1);
    assert.equal((await app.send(role)).body.code, 'HISTORY_LIMIT');
    assert.equal(calls, 1);
    const reset = await app.request(role + '/session', 'DELETE');
    assert.deepEqual(reset.body.messages, []);
    assert.equal('notes' in reset.body, false);
    assert.equal((await app.send(role)).status, 200);
});

test('Agent 回复超过上限时不写入角色文件；失败后可正常发送', async t => {
    let reply = { ...offlineReply, reply: '甲'.repeat(LIMITS.replyLength + 1) };
    const app = await setup(t, async () => reply);
    const role = await app.create();
    const path = app.recordPath(role);
    const original = await readFile(path, 'utf8');
    const failed = await app.send(role);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'AGENT_REPLY_TOO_LONG');
    assert.equal(await readFile(path, 'utf8'), original);
    reply = offlineReply;
    assert.equal((await app.send(role)).status, 200);
});

test('零插件无业务路由；显式加载后只发布注册资源，卸载撤销侧栏、钩子和路由', async t => {
    const bare = await setup(t, undefined, false);
    const bareRole = await bare.create();
    assert.deepEqual((await bare.request('/api/plugins/ui')).body, []);
    assert.equal((await bare.request(notesPath(bareRole))).status, 404);
    assert.equal((await bare.request(bareRole + '/notes')).status, 404);

    const turns = [];
    const app = await setup(t, async input => { turns.push(input); return offlineReply; });
    const role = await app.create();
    const slots = (await app.request('/api/plugins/ui')).body;
    assert.equal(slots.length, 1);
    assert.equal(slots[0].slot, 'sidebar');
    assert.equal(slots[0].pluginId, 'story-clues');
    const browserEntry = await fetch(app.origin + slots[0].entry);
    assert.equal(browserEntry.status, 200);
    assert.equal(browserEntry.headers.get('cache-control'), 'no-store');
    await browserEntry.text();
    assert.equal((await app.request('/plugin-assets/story-clues/index.js')).status, 404);
    assert.equal((await app.request('/plugin-assets/story-clues/plugin.json')).status, 404);
    assert.equal((await app.request(notesPath(role), 'PUT', notes)).status, 200);
    assert.equal(await app.kernel.unregister('story-clues'), true);
    assert.deepEqual((await app.request('/api/plugins/ui')).body, []);
    assert.equal((await app.request(slots[0].entry)).status, 404);
    assert.equal((await app.request(notesPath(role))).status, 404);
    assert.equal((await app.send(role)).status, 200);
    assert.deepEqual(turns[0].context, []);
});

function makeMessages(count) {
    return Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '旧消息' }));
}

async function setup(t, agent = async () => offlineReply, enable = true) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-notes-test-'));
    if (enable) await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'story-clues': { enabled: true } } }));
    const { app, kernel } = await createRuntime({ dataDir, agent, logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await kernel.dispose();
        await rm(dataDir, { recursive: true, force: true });
    });
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function request(path, method = 'GET', data, headers) {
        const response = await fetch(origin + path, {
            method,
            headers: data === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
            body: data === undefined ? undefined : JSON.stringify(data),
            signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.json() };
    }

    return {
        origin, kernel, request,
        async create() {
            const result = await request(api, 'POST', profile);
            assert.equal(result.status, 201);
            return api + '/' + result.body.id;
        },
        send: role => request(role + '/messages', 'POST', { message: '继续？' }),
        recordPath: role => join(dataDir, 'characters', role.split('/').at(-1) + '.json'),
    };
}
