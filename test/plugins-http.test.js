// Runs the three example plugins through the loopback host and an offline model mock.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../server.js';
import { contentType, delta, frame, readMockRequest, startOpenAIMock } from '../fixtures/mock-openai.mjs';

test('三个示范插件从白名单联动，模型断流不提交，停用回到默认槽位', async t => {
    let upstream;
    let truncated = false;
    const endpoint = await startOpenAIMock(t, async (req, res) => {
        upstream = await readMockRequest(req);
        res.writeHead(200, contentType);
        res.write(frame(delta('来自离线模型。')));
        if (!truncated) res.write(frame(delta(undefined, 'stop')) + frame('[DONE]'));
        res.end();
    });

    const dataDir = await mkdtemp(join(tmpdir(), 'write-plugin-combo-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const plugins = {
        'story-clues': { enabled: true },
        'persona-guard': { enabled: true, config: { persona: '旅人手持纸灯。', noRepetition: false } },
        'agent-openai-compat': {
            enabled: true, config: { baseUrl: endpoint + '/v1', model: 'fake', timeoutMs: 5000 },
        },
    };
    await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({ plugins }));
    const { app, kernel } = await createRuntime({ dataDir, agent: async () => ({ reply: '默认回复', sessionId: 'default' }), logger: { error() {} } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await kernel.dispose();
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const fetchLocal = (path, method = 'GET', body) => fetch(origin + path, {
        method, signal: AbortSignal.timeout(5000),
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });

    assert.equal((await (await fetchLocal('/api/health')).json()).agent, 'agent-openai-compat');
    const create = await fetchLocal('/api/characters', 'POST', { name: '书房猫', description: '调查线索。' });
    assert.equal(create.status, 201);
    const { id } = await create.json();
    const character = '/api/characters/' + id;
    const notes = '/api/plugins/story-clues/notes/' + id;
    assert.equal((await fetchLocal(notes, 'PUT', { clues: ['书房灯灭了'], summary: '先找猫' })).status, 200);
    const first = await fetchLocal(character + '/messages/stream', 'POST', { message: '去哪？' });
    const events = await first.text();
    assert.match(events, /event: delta/);
    assert.match(events, /event: done/);
    assert.equal(upstream.url, '/v1/chat/completions');
    assert.match(upstream.body.messages[0].content, /书房灯灭了/);
    assert.match(upstream.body.messages[0].content, /旅人手持纸灯/);
    assert.equal(upstream.body.messages[1].content, '去哪？');

    const file = join(dataDir, 'characters', id + '.json');
    const before = await readFile(file, 'utf8');
    truncated = true;
    const failed = await fetchLocal(character + '/messages/stream', 'POST', { message: '断流' });
    const failedEvents = await failed.text();
    assert.match(failedEvents, /event: error/);
    assert.doesNotMatch(failedEvents, /event: done/);
    assert.equal(await readFile(file, 'utf8'), before);

    await kernel.unregister('agent-openai-compat');
    await kernel.unregister('story-clues');
    await kernel.unregister('persona-guard');
    assert.equal((await (await fetchLocal('/api/health')).json()).agent, 'codex');
    assert.equal((await fetchLocal(notes)).status, 404);
    assert.deepEqual(await (await fetchLocal('/api/plugins/ui')).json(), []);
    const defaultTurn = await fetchLocal(character + '/messages', 'POST', { message: '喵' });
    assert.equal((await defaultTurn.json()).messages.at(-1).text, '默认回复');
});
