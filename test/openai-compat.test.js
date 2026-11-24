// Uses loopback HTTP only; no keys or third-party model provider needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../plugins/agent-openai-compat/index.js';
import { readCompletion } from '../plugins/agent-openai-compat/sse.js';
import { contentType, delta, frame, readMockRequest, startOpenAIMock } from './fixtures/mock-openai.mjs';

const request = {
    cwd: '.',
    character: { name: '猫', description: '阁楼侦探', greeting: '' },
    history: [{ role: 'user', text: '上轮' }, { role: 'assistant', text: '线索' }],
    context: [{ pluginId: 'story-clues', data: { summary: '猫爪印' } }],
    message: '发现了什么？',
    sessionId: 'existing-local-id',
};

test('兼容 HTTP Agent 只发送显式目的端，流式文本可续聊，且未声明工具', async t => {
    let received;
    const endpoint = await startOpenAIMock(t, async (req, res) => {
        received = await readMockRequest(req);
        res.writeHead(200, contentType);
        res.write(': keep-alive\r\n\r\n' + frame({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '私有思考' }, finish_reason: null }] }));
        res.write(frame({ choices: [] }) + frame(delta('脚印')) + frame({ choices: [] }));
        res.end(frame(delta('在楼上。', 'stop')) + frame({ choices: [], usage: { total_tokens: 42 } }) + frame('[DONE]'));
    });
    const { agent } = install({ baseUrl: endpoint + '/v1/', model: 'mock-model' });
    const fragments = [];
    const result = await agent.run.stream({ ...request, onDelta: text => fragments.push(text) });
    assert.deepEqual(fragments, ['脚印', '在楼上。']);
    assert.deepEqual(result, { reply: '脚印在楼上。', sessionId: 'existing-local-id' });
    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.headers.authorization, undefined);
    assert.deepEqual(Object.keys(received.body).sort(), ['messages', 'model', 'stream']);
    assert.equal(received.body.model, 'mock-model');
    assert.match(received.body.messages[0].content, /猫爪印/);
    assert.deepEqual(received.body.messages.slice(1), [
        { role: 'user', content: '上轮' },
        { role: 'assistant', content: '线索' },
        { role: 'user', content: '发现了什么？' },
    ]);
    const fresh = await agent.run({ ...request, sessionId: null });
    assert.match(fresh.sessionId, /^[a-f0-9-]{36}$/);
});

test('逐字节拆分 Unicode、CRLF 和多行 SSE 数据不会改变结果', async () => {
    const raw = [
        ': heartbeat',
        '',
        'data: {"choices":[',
        'data: {"index":0,"delta":{"content":"猫🐈"},"finish_reason":null}]}',
        '',
        'data: ' + JSON.stringify(delta('结束。', 'stop')),
        '',
        'data: [DONE]',
        '',
        '',
    ].join('\r\n');
    const bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
    } });
    const fragments = [];
    const reply = await readCompletion(new Response(body, { headers: contentType }), text => fragments.push(text));
    assert.deepEqual(fragments, ['猫🐈', '结束。']);
    assert.equal(reply, '猫🐈结束。');
});

test('未收到自然结束与 DONE、拒绝或试图调用工具的轮次都失败', async () => {
    for (const [payload, code] of [
        [frame(delta('半截', 'stop')), 'AGENT_INCOMPLETE'],
        [frame(delta('半截')) + frame('[DONE]'), 'AGENT_INCOMPLETE'],
        [frame({ choices: [] }) + frame('[DONE]'), 'AGENT_INCOMPLETE'],
        [frame(delta('半截', 'length')) + frame('[DONE]'), 'AGENT_INCOMPLETE'],
        [frame({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'no' }] }, finish_reason: null }] }), 'AGENT_INCOMPLETE'],
        ['data: {oops}\n\n', 'AGENT_PROTOCOL'],
        [frame({ error: { message: 'upstream data must stay private' } }), 'AGENT_UNAVAILABLE'],
        [frame(delta('a'.repeat(32_001), 'stop')) + frame('[DONE]'), 'AGENT_REPLY_TOO_LONG'],
    ]) {
        await assert.rejects(readCompletion(new Response(payload, { headers: contentType })), { code });
    }
});

test('客户端 Abort 或插件卸载真正关闭进行中的上游连接', async t => {
    for (const stopBy of ['client', 'dispose']) {
        const closed = Promise.withResolvers();
        const seen = Promise.withResolvers();
        const endpoint = await startOpenAIMock(t, (req, res) => {
            res.once('close', closed.resolve);
            res.writeHead(200, contentType);
            res.write(frame(delta('收到一半')));
        });
        const controller = new AbortController();
        const { agent, dispose } = install({ baseUrl: endpoint, model: 'mock' });
        const run = agent.run.stream({ ...request, signal: controller.signal, onDelta: seen.resolve });
        const failure = assert.rejects(run, { code: stopBy === 'client' ? 'STREAM_ABORTED' : 'AGENT_UNAVAILABLE' });
        await seen.promise;
        if (stopBy === 'client') controller.abort(); else dispose();
        await failure;
        await closed.promise;
    }
});

test('非本地 HTTP、网址凭据及重定向被拒绝', async t => {
    assert.throws(() => install({ baseUrl: 'http://example.com/v1', model: 'mock' }), /HTTPS/);
    assert.throws(() => install({ baseUrl: 'https://example.com?secret=key', model: 'mock' }), /URL/);
    assert.throws(() => install({ baseUrl: 'https://user:pass@example.com', model: 'mock' }), /凭据/);
    let hits = 0;
    const endpoint = await startOpenAIMock(t, (_req, res) => {
        hits++;
        res.writeHead(307, { Location: '/not-a-model' }).end();
    });
    const { agent } = install({ baseUrl: endpoint, model: 'mock' });
    await assert.rejects(agent.run(request), { code: 'AGENT_UNAVAILABLE' });
    assert.equal(hits, 1);
});

function install(config) {
    let agent;
    let dispose;
    apply({ provide: (_name, value) => { agent = value; }, onDispose: callback => { dispose = callback; } }, config);
    return { agent, dispose };
}
