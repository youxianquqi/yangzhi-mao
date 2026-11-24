// Exercises real OS locking and crash recovery using a temporary data directory.
// No Codex process or network is needed; only a fixture Node process is spawned.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCharacterLock } from '../src/character-lock.js';

const fixture = fileURLToPath(new URL('../fixtures/hold-lock.mjs', import.meta.url));
const busy = { code: 'CHARACTER_BUSY', status: 409 };
const childTimeoutMs = 10_000;

test('跨进程锁拒绝活跃所有者，终止后只有一个竞争者可接管', { timeout: childTimeoutMs }, async t => {
    const { dataDir, id, mutex, beforeCleanup } = await setup(t);
    const child = fork(fixture, [dataDir, id], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    beforeCleanup(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
    });
    const notification = await Promise.race([once(child, 'message').then(([message]) => message), exited.then(() => null)]);
    assert.equal(notification, 'locked');

    await assert.rejects(mutex.acquire(id.toUpperCase()), busy);
    const otherRelease = await mutex.acquire(randomUUID());
    await otherRelease();

    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    const lockPath = join(dataDir, 'locks', id + '.lock');
    const stale = await readFile(lockPath, 'utf8');
    await writeFile(lockPath + '.reap', '');
    await assert.rejects(mutex.acquire(id), busy);
    assert.equal(await readFile(lockPath, 'utf8'), stale);
    await unlink(lockPath + '.reap');

    const results = await Promise.allSettled([mutex.acquire(id), mutex.acquire(id)]);
    const claimed = results.filter(result => result.status === 'fulfilled');
    assert.equal(claimed.length, 1, results.map(result => String(result.reason ?? result.status)).join(', '));
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CHARACTER_BUSY');
    const release = claimed[0].value;
    await release();
    await release();
    const next = await mutex.acquire(id);
    await next();
});

test('残缺和外地主机的锁不能自动删除或覆盖', async t => {
    const { dataDir, id, mutex } = await setup(t);
    const lock = join(dataDir, 'locks', id + '.lock');
    const contents = [
        '{bad JSON',
        JSON.stringify({ host: hostname() + '.elsewhere', pid: process.pid, token: randomUUID() }),
    ];
    for (const entry of contents) {
        await writeFile(lock, entry);
        await assert.rejects(mutex.acquire(id), busy);
        assert.equal(await readFile(lock, 'utf8'), entry);
    }
});

async function setup(t) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-lock-test-'));
    let stop = () => {};
    t.after(async () => {
        try {
            await stop();
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
    return { dataDir, id: randomUUID(), mutex: await createCharacterLock(dataDir), beforeCleanup: task => { stop = task; } };
}
