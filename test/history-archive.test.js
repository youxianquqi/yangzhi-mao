import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '../server.js';
import { LIMITS } from '../src/config.js';
import { createArchiveStore } from '../src/history-archive.js';
import { createStorageService } from '../src/storage.js';

test('归档分页跨多分片和活跃窗口；读取不迁移旧档，只在成功提交后落盘', async t => {
    const received = [];
    let fail = true;
    const app = await setup(t, async request => {
        received.push(request);
        if (fail) throw new Error('offline mock failure');
        return { reply: '新回复', sessionId: request.sessionId ?? 'mock' };
    });
    const { id } = await app.request('/api/characters', 'POST', { name: '档案猫', description: '保存故事' });
    const line = threadPath(id, id);
    const path = join(app.dataDir, 'characters', id + '.json');
    const initial = await seed(path, 620);
    const paging = line + '/messages';
    const old = await app.request(paging + '?before=480&limit=100');
    assert.deepEqual(old.messages, initial.messages.slice(380, 480));
    const original = await readFile(path, 'utf8');
    await app.request(paging, 'POST', { message: '不会提交' }, 500);
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(stat(join(app.dataDir, 'archives')), { code: 'ENOENT' });

    fail = false;
    const streamed = await app.fetch(paging + '/stream', 'POST', { message: '新增一轮' });
    assert.equal(streamed.status, 200);
    const terminal = (await streamed.text()).match(/^event: done\r?\ndata: ([^\r\n]+)$/m);
    assert.ok(terminal);
    const done = JSON.parse(terminal[1]);
    assert.equal(done.total, 622);
    assert.deepEqual(done.messages.map(message => message.text), ['新增一轮', '新回复']);
    assert.equal(received.at(-1).history.length, LIMITS.historyMessages);
    assert.equal(received.at(-1).history[0].text, 'm420');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.archive.length, 7);
    assert.equal(stored.messages.length, 174);
    const dir = shardDir(app.dataDir, id, id);
    assert.equal((await readdir(dir)).length, 7);
    if (process.platform !== 'win32') {
        assert.equal((await stat(dir)).mode & 0o777, 0o700);
        assert.equal((await stat(join(dir, stored.archive[0].id + '.json'))).mode & 0o777, 0o600);
    }
    assert.equal((await app.request(line)).messageCount, 622);
    assert.equal((await app.request('/api/characters/' + id + '/threads'))[0].messageCount, 622);
    const cross = await app.request(paging + '?before=480&limit=100');
    assert.equal(cross.start, 380);
    assert.equal(cross.revision, done.revision);
    assert.deepEqual(cross.messages, initial.messages.slice(380, 480));

    const full = [];
    let before = done.total;
    while (before > 0) {
        const page = await app.request(paging + '?before=' + before);
        assert.equal(page.revision, done.revision);
        assert.equal(page.total, done.total);
        assert.equal(page.start + page.messages.length, before);
        full.unshift(...page.messages);
        before = page.start;
    }
    assert.deepEqual(full, [...initial.messages, ...done.messages]);
    await app.request(paging, 'POST', { message: '仍有活跃窗口空间' });
    assert.equal((await readdir(dir)).length, 7);
});

test('旧快照遇到已替换分片重读修订；归档编辑、截断、重抽与按 Agent 重置', async t => {
    const app = await setup(t, async request => ({ reply: '回覆:' + request.message, sessionId: request.sessionId ?? 'Codex' }));
    const { id } = await app.request('/api/characters', 'POST', { name: '线程猫', description: '分开故事' });
    const created = await app.request('/api/characters/' + id + '/threads', 'POST', { name: '长线' });
    const threadId = created.id;
    const path = join(app.dataDir, 'threads', id, threadId + '.json');
    const line = threadPath(id, threadId);
    const paging = line + '/messages';
    await seed(path, 620);
    await app.request(paging, 'POST', { message: '旧提供方的新消息' });
    const disk = JSON.parse(await readFile(path, 'utf8'));
    const prior = await app.request(paging);
    const dir = shardDir(app.dataDir, id, threadId);

    app.beforeRead(async () => {
        const edited = await app.request(paging + '/320', 'PATCH', { text: '修正的旧消息', revision: prior.revision });
        assert.equal(edited.messageCount, prior.total);
    });
    const reread = await app.request(paging + '?before=322&limit=3');
    assert.notEqual(reread.revision, prior.revision);
    assert.deepEqual(reread.messages.map(m => m.text), ['m319', '修正的旧消息', 'm321']);
    assert.equal((await app.request(paging + '/320', 'PATCH', { text: '过时', revision: prior.revision }, 409)).code, 'THREAD_CHANGED');
    const replaced = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(replaced.archive.length, disk.archive.length);
    assert.equal(replaced.archive.filter((ref, index) => ref.id !== disk.archive[index].id).length, 1);
    await assert.rejects(stat(join(dir, disk.archive[5].id + '.json')), { code: 'ENOENT' });

    const truncated = await app.request(paging + '/350?revision=' + reread.revision, 'DELETE');
    assert.equal(truncated.messageCount, 350);
    const cutDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await readdir(dir)).length, cutDisk.archive.length);
    const regen = await app.request(paging + '/regenerate', 'POST', { revision: truncated.revision });
    assert.equal(regen.messageCount, 350);
    assert.equal(regen.messages.at(-1).text, '回覆:m348');

    app.kernel.setDefaultAgent({ id: 'alternate', run: async () => ({ reply: '独立回复', sessionId: 'other' }) });
    assert.equal((await app.request(line)).messageCount, 0);
    await app.request(paging, 'POST', { message: '独立存档' });
    await app.request(line + '/session', 'DELETE');
    assert.equal((await app.request(paging)).total, 0);
    app.kernel.setDefaultAgent({ id: 'codex', run: async () => ({ reply: '回到旧档', sessionId: 'Codex' }) });
    assert.equal((await app.request(paging + '?before=322&limit=3')).messages[1].text, '修正的旧消息');
    assert.equal((await app.request(threadPath(id, id))).messageCount, 0);
    await app.request(line, 'DELETE', undefined, 204);
    assert.deepEqual(await readdir(dir), []);
});

test('主档提交失败时移除已暂存的孤立分片', async t => {
    const dataDir = await temporary(t);
    const store = createArchiveStore(dataDir);
    const id = '12345678-1234-1234-1234-123456789abc';
    const blocked = join(dataDir, 'directory-not-json');
    await mkdir(blocked);
    const record = { id, provider: 'codex', sessionId: null, inactiveSessions: {}, messages: makeHistory(350) };
    await assert.rejects(store.commit(id, id, blocked, record), { code: 'STORAGE_ERROR' });
    assert.ok((await stat(blocked)).isDirectory());
    assert.deepEqual(await readdir(shardDir(dataDir, id, id)), []);
    assert.deepEqual((await readdir(dataDir)).sort(), ['archives', 'directory-not-json']);
});

async function setup(t, run) {
    const dataDir = await temporary(t);
    const storage = await createStorageService(dataDir);
    const read = storage.archive.read;
    let callback;
    storage.archive.read = async (...args) => {
        const pending = callback;
        callback = undefined;
        await pending?.();
        return read(...args);
    };
    const { app, kernel } = await createRuntime({ dataDir, agent: run, storage, logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    function fetchLocal(path, method = 'GET', body) {
        return fetch('http://127.0.0.1:' + server.address().port + path, {
            method, signal: AbortSignal.timeout(5000),
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
    }
    return {
        dataDir, kernel, fetch: fetchLocal, beforeRead(fn) { callback = fn; },
        async request(path, method = 'GET', body, status = method === 'POST' && !path.includes('/messages') ? 201 : 200) {
            const response = await fetchLocal(path, method, body);
            assert.equal(response.status, status);
            if (status !== 204) return response.json();
        },
    };
}

async function temporary(t) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-history-archive-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    return dataDir;
}

function threadPath(id, threadId) {
    return '/api/characters/' + id + '/threads/' + threadId;
}

function shardDir(dataDir, id, threadId) {
    return join(dataDir, 'archives', id, threadId, 'codex');
}

async function seed(path, count) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    const legacy = { ...record, messages: makeHistory(count) };
    delete legacy.inactiveSessions;
    delete legacy.provider;
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    return legacy;
}

function makeHistory(count) {
    return Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: 'm' + index }));
}
