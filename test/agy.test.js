// Exercises slot replacement and preservation of separate local histories.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../server.js';
import { runAgy } from '../plugins/agent-antigravity/agy.js';

const fake = fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url));
const codexSessionId = 'old-codex-session';
const codexAgent = async input => ({ sessionId: codexSessionId, reply: 'Codex：' + input.message });
const agyAgent = input => runAgy({ ...input, command: { file: process.execPath, prefix: [fake] } });
const profile = { name: '测试猫', description: '观察线索' };
const manifest = { id: 'agent-test', name: 'Test mock', version: '0.1.0', entry: 'index.js', slots: [], permissions: ['provide:agent'] };

test('替换全局 Agent 槽位时恢复各自历史；卸载恢复 Codex，重置只影响当时所用的历史', async t => {
    const { api, kernel } = await setup(t);
    const role = '/api/characters/' + (await api('/api/characters', 'POST', profile)).body.id;
    assert.equal((await api('/api/health')).body.agent, 'codex');
    const firstCodex = await api(role + '/messages', 'POST', { message: '只给 Codex' });
    assert.equal(firstCodex.body.sessionId, codexSessionId);
    assert.equal(await kernel.register(manifest, ctx => ctx.provide('agent', { id: 'agy', run: agyAgent })), true);

    const selected = await api(role);
    assert.equal(selected.body.provider, 'agy');
    assert.equal(selected.body.sessionId, null);
    assert.deepEqual(selected.body.messages, []);
    assert.equal('inactiveSessions' in selected.body, false);
    const firstAgy = await api(role + '/messages', 'POST', { message: '只给 agy' });
    assert.equal(firstAgy.status, 200, JSON.stringify(firstAgy.body));
    const agyId = firstAgy.body.sessionId;
    assert.notEqual(agyId, codexSessionId);
    assert.deepEqual(JSON.parse(firstAgy.body.messages.at(-1).text), {
        character: { ...profile, greeting: '' }, message: '只给 agy',
    });

    assert.equal(await kernel.unregister('agent-test'), true);
    const back = await api(role);
    assert.equal(back.body.sessionId, codexSessionId);
    assert.deepEqual(back.body.messages, firstCodex.body.messages);
    assert.equal(await kernel.register(manifest, ctx => ctx.provide('agent', { id: 'agy', run: agyAgent })), true);
    assert.equal((await api(role)).body.sessionId, agyId);
    assert.equal((await api(role + '/messages', 'POST', { message: '继续' })).body.sessionId, agyId);
    assert.equal((await api(role + '/session', 'DELETE')).body.sessionId, null);
    await kernel.unregister('agent-test');
    assert.deepEqual((await api(role)).body.messages, firstCodex.body.messages);
});

test('角色 JSON 不可替换服务槽；拒绝非严格策略、畸形 agy 输出，不保存失败轮次', async t => {
    const { api, kernel } = await setup(t);
    assert.equal((await api('/api/characters', 'POST', { ...profile, provider: '__proto__' })).body.provider, 'codex');
    await kernel.register(manifest, ctx => ctx.provide('agent', { id: 'agy', run: agyAgent }));
    const created = await api('/api/characters', 'POST', profile);
    const role = '/api/characters/' + created.body.id;
    for (const [message, status, code] of [['不安全策略', 503, 'AGY_POLICY'], ['畸形输出', 502, 'AGENT_PROTOCOL']]) {
        const result = await api(role + '/messages', 'POST', { message });
        assert.equal(result.status, status);
        assert.equal(result.body.code, code);
        assert.deepEqual((await api(role)).body, created.body);
    }
});

async function setup(t) {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-agy-test-'));
    const { app, kernel } = await createRuntime({ dataDir, agent: codexAgent, logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await kernel.dispose();
        await rm(dataDir, { recursive: true, force: true });
    });
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function api(path, method = 'GET', data) {
        const response = await fetch(origin + path, {
            method,
            ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
            signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.json() };
    }
    return { api, kernel };
}
