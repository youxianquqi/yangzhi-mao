// Exercises absolute history offsets and SSE commits without DOM or network access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readChatStream, requestThreadTurn } from '../public/stream.js';
import { applyThreadCommit, prependPage, readMessagePage } from '../public/thread-state.js';

const message = text => ({ role: 'user', text });
const reply = text => ({ role: 'assistant', text });
const recent = { messages: [message('第六十一条'), reply('第六十二条')], start: 60, total: 62, revision: 'rev-1' };
const regeneration = {
    sessionId: 'new-session', provider: 'codex', threadId: 'cat-thread', revision: 'rev-2', total: 62,
    updatedAt: '2026-01-01T00:00:00.000Z', messages: [reply('重抽所得')],
};

test('分页只拼接同一修订版本且邻接的历史，保留消息绝对偏移', () => {
    const previous = readMessagePage({ start: 58, total: 62, revision: 'rev-1', messages: [message('更早'), reply('旧回复')] });
    const merged = prependPage(readMessagePage(recent), previous);
    assert.equal(merged.start, 58);
    assert.equal(merged.total, 62);
    assert.equal(merged.messages[60 - merged.start].text, '第六十一条');
    assert.equal(prependPage(recent, { ...previous, revision: 'rev-outdated' }), null);
    assert.equal(prependPage(recent, { ...previous, start: 57 }), null);
    assert.throws(() => readMessagePage({ ...recent, start: -1 }), /消息分页/);
    assert.throws(() => readMessagePage({ ...recent, messages: [{ role: 'system', text: '无效' }] }), /消息分页/);
});

test('重抽只替换原有最后一条回复；总数变动须重新核对服务端', () => {
    const replaced = applyThreadCommit(recent, regeneration, true);
    assert.equal(replaced.total, recent.total);
    assert.equal(replaced.start, recent.start);
    assert.deepEqual(replaced.messages, [recent.messages[0], regeneration.messages[0]]);
    assert.equal(replaced.revision, 'rev-2');
    assert.equal(recent.messages.at(-1).text, '第六十二条');
    assert.equal(applyThreadCommit(recent, { ...regeneration, total: 63 }, true), null);
});

test('剧情线 SSE 只接受目标线和预期模式的保存确认；重抽发送修订号', async t => {
    const onDelta = () => assert.fail('该样本没有增量');
    const expectation = { mode: 'regenerate', threadId: 'cat-thread' };
    assert.deepEqual(await readChatStream(events(regeneration), onDelta, expectation), regeneration);
    await assert.rejects(readChatStream(events({ ...regeneration, threadId: 'another-thread' }), onDelta, expectation), /无效的回复流/);
    await assert.rejects(readChatStream(events(regeneration), onDelta, { ...expectation, mode: 'pair' }), /无效的回复流/);

    const send = t.mock.method(globalThis, 'fetch', async () => new Response(events(regeneration), {
        headers: { 'Content-Type': 'text/event-stream' },
    }));
    const result = await requestThreadTurn('/api/characters/cat/threads/cat-thread/messages/regenerate/stream', { revision: 'rev-1' }, {
        ...expectation, signal: new AbortController().signal, onDelta,
    });
    assert.equal(result.messages[0].text, '重抽所得');
    assert.equal(send.mock.calls[0].arguments[1].body, '{"revision":"rev-1"}');
});

function events(result) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('event: done\ndata: ' + JSON.stringify(result) + '\n\n'));
            controller.close();
        },
    });
}
