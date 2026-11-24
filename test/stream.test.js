// Integration coverage spans HTTP, the native child-process adapter and on-disk commits.
// Fixtures run offline and use deterministic gates rather than delays for correctness assertions.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { runCodex, runCodexStream } from '../src/agents/codex.js';

const mock = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const command = { file: process.execPath, prefix: [mock] };
const agent = Object.assign(input => runCodex({ ...input, command }), {
    stream: input => runCodexStream({ ...input, command, timeoutMs: 15_000 }),
});
const profile = { name: '小写', description: '调查线索。' };

test('SSE 分片先到，完整 done 后用户和助手消息才原子写入', async t => {
    const app = await setup(t);
    const role = await app.create();
    const gate = join(app.workspace, 'fixture-continue');
    const before = await app.read(role);
    const { response, next } = await app.open(role, '流式等待');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('connection'), 'keep-alive');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await next(), { event: 'delta', data: { text: '第一段' } });
    assert.equal(await app.read(role), before);

    await writeFile(gate, '');
    assert.deepEqual(await next(), { event: 'delta', data: { text: '第二段' } });
    const done = await next();
    assert.equal(done.event, 'done');
    const stored = JSON.parse(await app.read(role));
    assert.deepEqual(stored.messages, [
        { role: 'user', text: '流式等待' }, { role: 'assistant', text: '第一段第二段' },
    ]);
    assert.deepEqual(done.data, {
        sessionId: stored.sessionId, messages: stored.messages, updatedAt: stored.updatedAt, provider: 'codex',
    });
    assert.equal(await next(), null);
});

test('流式占用角色时 JSON 和 SSE 都返回 409；客户端断开后子进程树回收且不落盘', async t => {
    const app = await setup(t);
    const role = await app.create();
    const original = await app.read(role);
    const cancellation = new AbortController();
    t.after(() => cancellation.abort());
    const { next } = await app.open(role, '流式挂起', cancellation.signal);
    assert.deepEqual(await next(), { event: 'delta', data: { text: '第一段' } });
    const [child, descendant] = await Promise.all(['fixture-pid', 'fixture-descendant-pid']
        .map(name => readFile(join(app.workspace, name), 'utf8').then(Number)));
    assert.ok(child > 0 && descendant > 0 && child !== descendant);
    assert.equal(await processIsLive(child), true);
    assert.equal(await processIsLive(descendant), true);

    for (const suffix of ['/messages', '/messages/stream']) {
        const response = await app.post(role.path + suffix, { message: '不能并发' });
        assert.equal(response.status, 409);
        assert.match(response.headers.get('content-type'), /^application\/json/);
        assert.equal((await response.json()).code, 'CHARACTER_BUSY');
    }

    cancellation.abort();
    await waitFor(async () => !await processIsLive(child) && !await processIsLive(descendant) && !await exists(app.lock(role)));
    assert.equal(await app.read(role), original);
    const resumed = await app.post(role.path + '/messages', { message: '锁已释放' });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).messages.length, 2);
});

test('流内失败返回相同 X-Request-Id；没有 done 或磁盘修改', async t => {
    const app = await setup(t);
    const role = await app.create();
    const original = await app.read(role);
    const { response, next } = await app.open(role, '流式失败');
    assert.equal(response.status, 200);
    assert.deepEqual(await next(), { event: 'delta', data: { text: '第一段' } });
    const error = await next();
    assert.equal(error.event, 'error');
    assert.equal(error.data.status, 502);
    assert.equal(error.data.code, 'AGENT_UNAVAILABLE');
    assert.equal(error.data.requestId, response.headers.get('x-request-id'));
    assert.equal(await next(), null);
    assert.equal(await app.read(role), original);
    assert.equal(await exists(app.lock(role)), false);
});

async function setup(t) {
    const dir = await mkdtemp(join(tmpdir(), 'write-sse-test-'));
    const app = await createApp({ dataDir: dir, agent, logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    });
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    async function post(path, data, signal = AbortSignal.timeout(10_000)) {
        return fetch(url + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data), signal,
        });
    }
    return {
        workspace: join(dir, 'agent-workspace'), post,
        async create() {
            const response = await post('/api/characters', profile);
            assert.equal(response.status, 201);
            const { id } = await response.json();
            return { id, path: '/api/characters/' + id };
        },
        async open(role, message, signal) {
            const response = await post(role.path + '/messages/stream', { message }, signal);
            return { response, next: readerFor(response) };
        },
        read: role => readFile(join(dir, 'characters', role.id + '.json'), 'utf8'),
        lock: role => join(dir, 'locks', role.id + '.lock'),
    };
}

function readerFor(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    return async () => {
        while (!body.includes('\n\n')) {
            const { done, value } = await reader.read();
            if (done) {
                assert.equal(body, '');
                return null;
            }
            body += decoder.decode(value, { stream: true });
        }
        const end = body.indexOf('\n\n');
        const [event, data] = body.slice(0, end).split('\n');
        body = body.slice(end + 2);
        return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
    };
}

async function exists(path) {
    try { await stat(path); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function processIsLive(pid) {
    try {
        if (process.platform === 'linux') {
            // Containers may not immediately reap an orphaned zombie after process-group termination.
            const data = await readFile('/proc/' + pid + '/stat', 'utf8');
            return data.slice(data.lastIndexOf(')') + 2, data.lastIndexOf(')') + 3) !== 'Z';
        }
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
        throw error;
    }
}

async function waitFor(predicate) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
        if (await predicate()) return;
        await wait(25);
    }
    assert.fail('Timed out waiting for child tree teardown and unlocked role');
}
