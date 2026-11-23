import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runCodex } from '../src/agents/codex.js';
import { createApp } from '../server.js';

const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const cliAgent = options => runCodex({ ...options, command: { file: process.execPath, prefix: [fake] } });
const profile = { name: '小写', description: '请记住用户交代的口令。', greeting: '你好！' };
const quietLogger = { info() {}, warn() {}, error() {} };

async function start(dataDir, agent) {
    const app = await createApp({ dataDir, agent, logger: quietLogger });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    return {
        origin,
        close: () => new Promise(resolve => server.close(resolve)),
        request: async (path, { method = 'GET', data, headers } = {}) => {
            const response = await fetch(origin + path, {
                method,
                headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
                body: data === undefined ? undefined : JSON.stringify(data),
                signal: AbortSignal.timeout(5000),
            });
            return { status: response.status, headers: response.headers, body: await response.json() };
        },
    };
}

async function fixture(t, agent = cliAgent) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-test-'));
    let server;
    t.after(async () => {
        await server?.close();
        await rm(dataDir, { recursive: true, force: true });
    });
    return {
        dataDir,
        restart: async () => {
            await server?.close();
            server = await start(dataDir, agent);
            return server;
        },
    };
}

async function createRole(app) {
    const response = await app.request('/api/characters', { method: 'POST', data: profile });
    assert.equal(response.status, 201);
    return '/api/characters/' + response.body.id;
}

function send(app, role, message) {
    return app.request(role + '/messages', { method: 'POST', data: { message } });
}

function assertError(response, status, code) {
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.equal(typeof response.body.error, 'string');
    assert.ok(response.body.error.length);
    if (code) assert.equal(response.body.code, code);
    assert.ok(response.headers.get('x-request-id'));
    assert.equal(response.body.requestId, response.headers.get('x-request-id'));
}

test('本地页面与健康检查可用，错误携带请求 ID，拒绝跨站请求', async t => {
    const { restart } = await fixture(t);
    const app = await restart();
    const page = await fetch(app.origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Write · 角色对话/);

    const health = await app.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.agent, 'codex');

    const invalid = await app.request('/api/characters', { method: 'POST', data: { ...profile, name: '   ' } });
    assertError(invalid, 400, 'INVALID_INPUT');

    const crossSite = await app.request('/api/characters', { headers: { Origin: 'https://example.com' } });
    assertError(crossSite, 403);
    assert.equal(crossSite.headers.get('access-control-allow-origin'), null);

    const missing = await app.request('/api/characters/not-an-id');
    assertError(missing, 404, 'CHARACTER_NOT_FOUND');
});

test('只存完整回复；忽略工具和中间事件，重启后还能续聊和重置', async t => {
    const { restart } = await fixture(t);
    let app = await restart();
    const role = await createRole(app);

    const first = await send(app, role, '记住密码是青竹。');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.sessionId);
    assert.deepEqual(first.body.messages.map(({ role, text }) => [role, text]), [
        ['user', '记住密码是青竹。'],
        ['assistant', '我记住了。'],
    ]);

    const failed = await send(app, role, '模拟网络故障。密码是什么？');
    assertError(failed, 502);
    assert.match(failed.body.error, /网络|连接/);

    assertError(await send(app, role, '模拟中途结束。密码是什么？'), 502);

    app = await restart();
    const restored = await app.request(role);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.sessionId, first.body.sessionId);
    assert.deepEqual(restored.body.messages, first.body.messages);

    const next = await send(app, role, '密码是什么？');
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.sessionId, first.body.sessionId);
    assert.equal(next.body.messages.length, 4);
    assert.equal(next.body.messages.at(-1).text, '青竹。');

    const reset = await app.request(role + '/session', { method: 'DELETE' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.sessionId, null);
    assert.deepEqual(reset.body.messages, []);
    assert.equal(reset.body.greeting, profile.greeting);
});

test('同一角色不允许并行写入，首个请求只提交一轮', async t => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    const agent = async () => {
        if (++calls !== 1) throw new Error('不应调用第二次 Agent');
        entered.resolve();
        await release.promise;
        return { reply: '仅一个回复。', sessionId: '71a595b0-8995-4ab2-9000-5a27d4c8dd95' };
    };
    const { restart } = await fixture(t, agent);
    const app = await restart();
    const role = await createRole(app);
    const pending = send(app, role, '第一次请求');
    try {
        await Promise.race([
            entered.promise,
            pending.then(result => assert.fail('首个请求未进入 Agent：' + JSON.stringify(result.body))),
        ]);
        assertError(await send(app, role, '不应提交'), 409, 'CHARACTER_BUSY');
        const before = await app.request(role);
        assert.deepEqual(before.body.messages, []);
    } finally {
        release.resolve();
        await pending.catch(() => {});
    }
    assert.equal((await pending).status, 200);
    const after = await app.request(role);
    assert.deepEqual(after.body.messages.map(({ text }) => text), ['第一次请求', '仅一个回复。']);
    assert.equal(calls, 1);
});

test('升级后能读取并续聊已有的角色 JSON 存档', async t => {
    const { dataDir, restart } = await fixture(t);
    const characters = join(dataDir, 'characters');
    await mkdir(characters);
    const legacy = {
        id: 'bc46e520-1e24-4450-9052-bf0030647488',
        ...profile,
        sessionId: '71a595b0-8995-4ab2-9000-5a27d4c8dd95',
        messages: [{ role: 'user', text: '记住密码是青竹。' }, { role: 'assistant', text: '我记住了。' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(characters, legacy.id + '.json'), JSON.stringify(legacy), 'utf8');

    const app = await restart();
    const role = '/api/characters/' + legacy.id;
    const restored = await app.request(role);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.messages, legacy.messages);
    const next = await send(app, role, '密码是什么？');
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.sessionId, legacy.sessionId);
    assert.equal(next.body.messages.length, 4);
});
