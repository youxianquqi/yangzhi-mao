// Exercise the real loopback HTTP boundary without a vendor account or external network.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../server.js';
import { contentType, delta, frame } from './fixtures/mock-openai.mjs';

test('settings keep the localhost boundary, redact keys and switch model histories without restart', async t => {
    const requests = [];
    const secret = 'fake-secret-example-1234';
    const api = await openRuntime(t, {
        modelFetch: async (url, init) => {
            requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
            return new Response(frame({ choices: [] }) + frame(delta('喵'))
                + frame(delta(undefined, 'stop')) + frame({ choices: [], usage: { total_tokens: 4 } }) + frame('[DONE]'),
            { headers: contentType });
        },
    });
    const initial = await api.request('/api/settings');
    assert.equal(initial.status, 200);
    assert.match(initial.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const unconfigured = await initial.json();
    assert.equal(unconfigured.activeAgent, 'deepseek');
    assert.equal(unconfigured.modelAvailable, false);
    for (const headers of [
        { Origin: 'https://other.invalid' }, { Host: 'other.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
        assert.equal(await api.rawStatus('/api/settings', headers), 403);
    }
    assert.equal((await api.request('/api/settings/model', { method: 'PUT', body: '{}' })).status, 415);
    const outside = await api.json('/api/settings/model/test', 'POST', {
        preset: 'deepseek', baseUrl: 'https://other.invalid', model: 'fake', apiKey: secret,
    });
    assert.ok(outside.status >= 400 && outside.status < 500);
    assert.equal(requests.length, 0);

    for (const preset of ['deepseek', 'minimax']) {
        const saved = await api.json('/api/settings/model', 'PUT', { preset, apiKey: secret });
        assert.equal(saved.status, 200);
        const text = await saved.text();
        assert.doesNotMatch(text, new RegExp(secret));
        const settings = JSON.parse(text);
        assert.equal(settings.model.apiKeyConfigured, true);
        assert.equal(settings.model.apiKeyLast4, '1234');
        assert.equal(settings.activeAgent, preset);
        assert.equal(settings.modelAvailable, true);
        assert.deepEqual((await api.json('/api/settings/model/test', 'POST', { preset }).then(res => res.json())), { ok: true });
        const character = await api.json('/api/characters', 'POST', { name: '接待猫', description: '引导员' }).then(res => res.json());
        const path = '/api/characters/' + character.id;
        const turn = await api.json(path + '/messages/stream', 'POST', { message: '你好' });
        assert.match(await turn.text(), /event: done/);
        const roleText = await readFile(join(api.dataDir, 'characters', character.id + '.json'), 'utf8');
        assert.doesNotMatch(roleText, new RegExp(secret));
        const record = JSON.parse(roleText);
        assert.equal(record.provider, preset);
        assert.equal(record.messages.at(-1).text, '喵');
    }
    assert.equal(requests.length, 4);
    assert.ok(requests.every(req => req.url.endsWith('/chat/completions')));
});

test('safe mode exposes settings but never re-enables plugins; normal mode can hot toggle built-ins only', async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-safe-settings-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({
        plugins: { 'story-clues': { enabled: true }, 'persona-guard': { enabled: false, config: { persona: '保留配置' } } },
    }));
    const safe = await openRuntime(t, { dataDir, env: { SAFE_MODE: '1' } });
    const initial = await safe.request('/api/settings').then(res => res.json());
    assert.equal(initial.safeMode, true);
    assert.equal(initial.plugins.find(item => item.id === 'story-clues').active, false);
    assert.deepEqual(await safe.request('/api/plugins/ui').then(res => res.json()), []);
    assert.deepEqual(await safe.request('/api/plugins/ui/defaults').then(res => res.json()), []);
    assert.equal((await safe.json('/api/settings/plugins/story-clues', 'PUT', { enabled: false })).status, 200);
    assert.equal((await safe.json('/api/settings/plugins/persona-guard', 'PUT', { enabled: true })).status, 200);
    assert.deepEqual(await safe.request('/api/plugins/ui').then(res => res.json()), []);

    const normal = await openRuntime(t, { dataDir, env: {} });
    const unknown = await normal.json('/api/settings/plugins/local-unreviewed', 'PUT', { enabled: true });
    assert.equal(unknown.status, 404);
    const before = await normal.request('/api/settings').then(res => res.json());
    assert.equal(before.plugins.find(item => item.id === 'persona-guard').active, true);
    assert.equal(before.plugins.find(item => item.id === 'story-clues').active, false);
    assert.equal((await normal.json('/api/settings/plugins/story-clues', 'PUT', { enabled: true })).status, 200);
    assert.ok((await normal.request('/api/plugins/ui').then(res => res.json())).some(item => item.pluginId === 'story-clues'));
    assert.equal((await normal.json('/api/settings/plugins/story-clues', 'PUT', { enabled: false })).status, 200);
    assert.deepEqual(await normal.request('/api/plugins/ui').then(res => res.json()), []);
    const { plugins } = JSON.parse(await readFile(join(dataDir, 'plugins.json'), 'utf8'));
    assert.equal(plugins['story-clues'].enabled, false);
    assert.equal(plugins['persona-guard'].config.persona, '保留配置');
    assert.ok(!Object.hasOwn(plugins, 'local-unreviewed'));
});

test('onboarding treats an environment key or an active alternate adapter as configured', async t => {
    const configured = await openRuntime(t, { env: { MINIMAX_API_KEY: 'mock-key-5678' } });
    const preset = await configured.request('/api/settings').then(res => res.json());
    assert.equal(preset.activeAgent, 'minimax');
    assert.equal(preset.model.apiKeySource, 'environment');
    assert.equal(preset.modelAvailable, true);

    const alternate = await openRuntime(t, { agent: async () => ({ reply: '喵', sessionId: 'mock' }) });
    const settings = await alternate.request('/api/settings').then(res => res.json());
    assert.equal(settings.model.apiKeyConfigured, false);
    assert.equal(settings.activeAgent, 'codex');
    assert.equal(settings.modelAvailable, true);
});

test('enabling the built-in importer exposes its toolbar component and only registered assets', async t => {
    const api = await openRuntime(t);
    const asset = '/plugin-assets/card-importer/';
    const getToolbar = () => api.request('/api/plugins/ui').then(res => res.json());
    assert.ok(!(await getToolbar()).some(item => item.pluginId === 'card-importer'));
    assert.equal((await api.request(asset + 'card.js')).status, 404);

    const response = await api.json('/api/settings/plugins/card-importer', 'PUT', { enabled: true });
    assert.equal(response.status, 200);
    const slot = (await getToolbar()).find(item => item.pluginId === 'card-importer');
    assert.equal(slot?.slot, 'toolbar');
    assert.equal(slot?.tag, 'card-importer-panel');
    assert.equal(slot?.entry, asset + 'card.js');
    assert.equal((await api.request(slot.entry)).status, 200);
    assert.equal((await api.request(asset + 'card.css')).status, 200);
    assert.equal((await api.request(asset + 'index.js')).status, 404);

    assert.equal((await api.json('/api/settings/plugins/card-importer', 'PUT', { enabled: false })).status, 200);
    assert.ok(!(await getToolbar()).some(item => item.pluginId === 'card-importer'));
    assert.equal((await api.request(asset + 'card.js')).status, 404);
});

async function openRuntime(t, options = {}) {
    const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'write-settings-http-'));
    if (!options.dataDir) t.after(() => rm(dataDir, { recursive: true, force: true }));
    const { app, kernel } = await createRuntime({ dataDir, env: {}, logger: { error() {} }, ...options });
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
    const request = (path, options) => fetch(origin + path, { signal: AbortSignal.timeout(5000), ...options });
    return {
        dataDir, request,
        rawStatus: (path, headers) => new Promise((resolve, reject) => {
            const req = requestHttp(origin + path, { headers }, res => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on('error', reject);
            req.end();
        }),
        json: (path, method, body) => request(path, {
            method, headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
        }),
    };
}
