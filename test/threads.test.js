// Exercises the public scenario API, transaction isolation and CLI context restoration offline.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../server.js';
import { runCodex } from '../src/agents/codex.js';
import { appError } from '../src/errors.js';

const profile = { name: '小写', description: '只调查书房，不替玩家行动。' };
const fake = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const firstSession = '71a595b0-8995-4ab2-9000-5a27d4c8dd95';
const roleRoot = '/api/characters';

test('旧角色无需重写即可读取默认线；新剧情线独立持久化，删除默认线后兼容接口回退', async t => {
    const app = await setup(t);
    const id = 'bc46e520-1e24-4450-9052-bf0030647488';
    const legacy = {
        id, ...profile, greeting: '', sessionId: firstSession, updatedAt: '2026-03-01T00:00:00.000Z',
        messages: [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '旧解答' }],
        notes: { summary: '旧插件字段', clues: [] },
    };
    const file = join(app.dataDir, 'characters', id + '.json');
    const bytes = JSON.stringify(legacy);
    await writeFile(file, bytes);
    const role = roleRoot + '/' + id;
    const primary = role + '/threads/' + id;
    assert.equal((await app.json(role + '/threads')).body[0].id, id);
    assert.deepEqual((await app.page(primary)).messages, legacy.messages);
    assert.equal(await readFile(file, 'utf8'), bytes);
    const last = await app.json(primary, { method: 'DELETE' });
    assert.equal(last.status, 409);

    const other = await app.newThread(role, '平行线');
    const otherLine = role + '/threads/' + other.id;
    assert.deepEqual((await app.page(otherLine)).messages, []);
    assert.equal((await app.json(otherLine + '/messages', { method: 'POST', body: { message: '新线消息' } })).status, 200);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.deepEqual((await app.json(role)).body.messages, legacy.messages);
    const differentRole = await app.newRole();
    assert.equal((await app.json(differentRole.path + '/threads/' + other.id)).status, 404);

    assert.equal((await app.json(primary, { method: 'DELETE' })).status, 204);
    assert.equal((await app.json(primary)).status, 404);
    assert.equal((await app.json(role)).body.messages[0].text, '新线消息');
    assert.deepEqual((await app.json(role + '/threads')).body.map(line => line.id), [other.id]);
});

test('分页、修订校验、单条编辑、重抽以及回退保留正确的本地前缀', async t => {
    const input = [];
    const app = await setup(t, async turn => {
        input.push(turn);
        return { sessionId: turn.sessionId ?? 'session-' + input.length, reply: '回复 ' + input.length };
    });
    const { path } = await app.newRole();
    const entry = await app.newThread(path, '书房');
    const line = path + '/threads/' + entry.id;
    for (const message of ['一', '二', '三']) {
        assert.equal((await app.json(line + '/messages', { method: 'POST', body: { message } })).status, 200);
    }
    const last = await app.page(line, '?limit=2');
    assert.equal(last.total, 6);
    assert.equal(last.start, 4);
    const older = await app.page(line, '?before=4&limit=2');
    assert.equal(older.start, 2);
    assert.equal(older.revision, last.revision);
    assert.deepEqual(older.messages.map(message => message.text), ['二', '回复 2']);
    assert.equal((await app.json(line + '/messages?limit=bad')).status, 400);

    const pathToEdit = line + '/messages/0';
    const changed = await app.json(pathToEdit, { method: 'PATCH', body: { text: '修订一', revision: last.revision } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.sessionId, null);
    assert.equal(changed.body.messages.length, 6);
    assert.notEqual(changed.body.revision, last.revision);
    assert.equal((await app.json(pathToEdit, { method: 'PATCH', body: { text: '旧页面', revision: last.revision } })).body.code, 'THREAD_CHANGED');
    assert.equal((await app.json(line + '/messages', { method: 'POST', body: { message: '旧页面', revision: last.revision } })).status, 409);
    assert.equal((await app.json(pathToEdit, { method: 'PATCH', raw: 'not-json' })).status, 415);

    const regen = await app.stream(line + '/messages/regenerate/stream', { revision: changed.body.revision });
    assert.equal(regen.status, 200);
    const frames = framesFrom(await regen.text());
    assert.deepEqual(frames.at(-1).data.messages, [{ role: 'assistant', text: '回复 4' }]);
    assert.equal(frames.at(-1).data.total, 6);
    assert.equal(frames.at(-1).data.threadId, entry.id);
    assert.equal(input[3].message, '三');
    assert.equal(input[3].sessionId, null);
    assert.deepEqual(input[3].history.map(message => message.text), ['修订一', '回复 1', '二', '回复 2']);

    const revision = frames.at(-1).data.revision;
    const cut = await app.json(line + '/messages/2?revision=' + revision, { method: 'DELETE' });
    assert.equal(cut.status, 200);
    assert.equal(cut.body.sessionId, null);
    assert.deepEqual(cut.body.messages.map(message => message.text), ['修订一', '回复 1']);
    assert.equal((await app.json(line + '/messages/regenerate', { method: 'POST', body: { revision } })).status, 409);
});

test('同线 SSE 占锁时其他线可提交；中途 Abort 与重抽流内 502 均保留已存聊天', async t => {
    let hold = false;
    let fail = false;
    const observedAbort = Promise.withResolvers();
    const agent = async turn => ({ sessionId: turn.sessionId ?? 'seed', reply: '已保存答复' });
    agent.stream = async turn => {
        turn.onDelta('临时增量');
        if (fail) throw appError('AGENT_UNAVAILABLE');
        if (hold) {
            await new Promise(resolve => turn.signal.addEventListener('abort', resolve, { once: true }));
            observedAbort.resolve();
        }
        return agent(turn);
    };
    const app = await setup(t, agent);
    const role = await app.newRole();
    const other = await app.newThread(role.path, '可并行');
    const line = role.path + '/threads/' + role.id;
    const different = role.path + '/threads/' + other.id;
    assert.equal((await app.json(line + '/messages', { method: 'POST', body: { message: '已保存问题' } })).status, 200);
    const original = await app.page(line);
    hold = true;
    const controller = new AbortController();
    t.after(() => controller.abort());
    const active = await app.stream(line + '/messages/regenerate/stream', { revision: original.revision }, controller.signal);
    assert.equal(active.status, 200);
    const received = active.body.getReader();
    assert.match(new TextDecoder().decode((await received.read()).value), /event: delta/);
    assert.equal((await app.json(line + '/messages', { method: 'POST', body: { message: '同线' } })).body.code, 'CHARACTER_BUSY');
    assert.equal((await app.json(different + '/messages', { method: 'POST', body: { message: '别线' } })).status, 200);
    assert.equal((await app.json(role.path, { method: 'DELETE' })).status, 409);

    controller.abort();
    await Promise.race([observedAbort.promise, pause(2000, undefined, { ref: false }).then(() => assert.fail('Agent did not observe Abort'))]);
    assert.deepEqual(await app.page(line), original);
    hold = false;
    fail = true;
    let rejected;
    for (let attempt = 0; attempt < 30; attempt++) {
        rejected = await app.stream(line + '/messages/regenerate/stream', { revision: original.revision });
        if (rejected.status !== 409) break;
        await rejected.text();
        await pause(10);
    }
    assert.equal(rejected.status, 200);
    const frames = framesFrom(await rejected.text());
    assert.deepEqual(frames.map(frame => frame.event), ['delta', 'error']);
    assert.equal(frames[1].data.status, 502);
    assert.equal(frames[1].data.requestId, rejected.headers.get('x-request-id'));
    assert.deepEqual(await app.page(line), original);
});

test('Codex 桩证明编辑后不续用旧远端会话，并收到修订后的已提交本地历史', async t => {
    const adapter = input => runCodex({ ...input, command: { file: process.execPath, prefix: [fake] } });
    const app = await setup(t, adapter);
    const role = await app.newRole();
    const line = role.path + '/threads/' + role.id;
    assert.equal((await app.json(line + '/messages', { method: 'POST', body: { message: '记住青竹。' } })).status, 200);
    const initial = await app.page(line);
    assert.equal((await app.json(line + '/messages/0', {
        method: 'PATCH', body: { text: '改记金竹。', revision: initial.revision },
    })).status, 200);
    const replay = await app.json(line + '/messages', { method: 'POST', body: { message: '回显测试剧情线' } });
    assert.equal(replay.status, 200);
    const payload = JSON.parse(replay.body.messages.at(-1).text);
    assert.deepEqual(payload.history.map(message => message.text), ['改记金竹。', '我记住了。']);
});

async function setup(t, agent = async turn => ({ reply: '答：' + turn.message, sessionId: turn.sessionId ?? 'mock-session' })) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-threads-test-'));
    const { app, kernel } = await createRuntime({ dataDir, agent, logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await kernel.dispose();
        await rm(dataDir, { recursive: true, force: true });
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const request = (path, { method = 'GET', body, raw, signal } = {}) => fetch(origin + path, {
        method, signal: signal ?? AbortSignal.timeout(5000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        ...(raw === undefined ? {} : { headers: { 'Content-Type': 'text/plain' }, body: raw }),
    });
    const json = async (path, options) => {
        const response = await request(path, options);
        return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    return {
        json, dataDir,
        newRole: async () => {
            const result = await json(roleRoot, { method: 'POST', body: profile });
            assert.equal(result.status, 201);
            return { id: result.body.id, path: roleRoot + '/' + result.body.id };
        },
        newThread: async (path, name) => {
            const result = await json(path + '/threads', { method: 'POST', body: { name } });
            assert.equal(result.status, 201);
            return result.body;
        },
        page: async (path, query = '') => {
            const result = await json(path + '/messages' + query);
            assert.equal(result.status, 200);
            return result.body;
        },
        stream: (path, body, signal) => request(path, { method: 'POST', body, signal }),
    };
}

function framesFrom(text) {
    return text.trim().split('\n\n').map(frame => {
        const [kind, data] = frame.split('\n');
        return { event: kind.slice(7), data: JSON.parse(data.slice(6)) };
    });
}
