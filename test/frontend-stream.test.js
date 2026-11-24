// Exercises the browser protocol and committed state without a DOM or real network.
// Partial replies must never be treated as persisted history.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateCharacter, commitStreamTurn, createChatState, isNearChatEnd } from '../public/state.js';
import { readChatStream, requestChatTurn } from '../public/stream.js';

const turn = {
    sessionId: 'session-1', updatedAt: '2026-01-01T00:00:00Z', provider: 'agy',
    messages: [{ role: 'user', text: '问句' }, { role: 'assistant', text: '确认答案 🐈' }],
};

test('SSE decoder handles byte-split UTF-8, split line breaks, and keepalives', async () => {
    const frames = ': keepalive\r\n\r\nevent: delta\r\ndata: {"text":\r\ndata: "猫🐈"}\r\n\r\n'
        + frame('delta', { text: '<b>原样文字</b>' }) + frame('done', turn);
    const chunks = [];
    const result = await readChatStream(streamOf(frames, 1), text => chunks.push(text));
    assert.deepEqual(chunks, ['猫🐈', '<b>原样文字</b>']);
    assert.deepEqual(result, turn);
});

test('SSE decoder rejects malformed JSON, missing terminal events, and malformed commits', async () => {
    const partial = frame('delta', { text: '未提交的文本' });
    await assert.rejects(readChatStream(streamOf(partial), () => {}), /未收到保存确认/);
    await assert.rejects(readChatStream(streamOf('event: delta\ndata: {\n\n'), () => {}), /无效的回复流/);
    const truncatedDone = frame('done', turn).slice(0, -1);
    await assert.rejects(readChatStream(streamOf(truncatedDone), () => {}), /未收到保存确认/);
    const wrongPair = { ...turn, messages: [turn.messages[1], turn.messages[0]] };
    await assert.rejects(readChatStream(streamOf(frame('done', wrongPair)), () => {}), /无效的回复流/);
});

test('stream request distinguishes JSON preflight and in-stream errors with request IDs', async t => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
        JSON.stringify({ error: '角色忙碌', code: 'CHARACTER_BUSY' }),
        { status: 409, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'preflight-id' } },
    ));
    const controller = new AbortController();
    const options = { signal: controller.signal, onDelta() { assert.fail('不应渲染错误'); } };
    const path = '/api/characters/role/messages/stream';
    await assert.rejects(requestChatTurn(path, '问题', options), /角色忙碌.*preflight-id/);
    assert.equal(fetchMock.mock.calls[0].arguments[1].body, '{"message":"问题"}');

    fetchMock.mock.mockImplementation(async () => new Response(
        frame('error', { error: '保存失败', requestId: 'terminal-id' }),
        { headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'header-id' } },
    ));
    let knownHeader;
    await assert.rejects(requestChatTurn(path, '问题', {
        ...options, onRequestId: id => { knownHeader = id; },
    }), /保存失败.*terminal-id/);
    assert.equal(knownHeader, 'header-id');
});

test('cancelled response preserves the known request ID but does not expose a commit', async t => {
    const controller = new AbortController();
    const body = new ReadableStream({
        start(stream) {
            controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason));
        },
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(body, {
        headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'cancel-id' },
    }));
    let knownHeader;
    const result = requestChatTurn('/api/characters/role/messages/stream', '问题', {
        signal: controller.signal,
        onRequestId: id => { knownHeader = id; controller.abort(); },
        onDelta() { assert.fail('不应渲染取消后的内容'); },
    });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(knownHeader, 'cancel-id');
});

test('only the canonical pair is committed and only to the requested role and provider', () => {
    const previous = { role: 'assistant', text: '原记录' };
    const current = { id: 'role', name: '猫', provider: 'agy', messages: [previous], sessionId: null };
    const state = activateCharacter(createChatState(), current);
    assert.equal(commitStreamTurn(state, 'another-role', turn), state);
    assert.equal(commitStreamTurn(state, current.id, { ...turn, provider: 'codex' }), state);
    const committed = commitStreamTurn(state, current.id, turn);
    assert.deepEqual(committed.current.messages, [previous, ...turn.messages]);
    assert.equal(committed.current.sessionId, turn.sessionId);
    assert.deepEqual(state.current.messages, [previous]);
});

test('smart scrolling follows the tail without pulling a reader from older messages', () => {
    assert.equal(isNearChatEnd({ scrollHeight: 1200, clientHeight: 400, scrollTop: 790 }), true);
    assert.equal(isNearChatEnd({ scrollHeight: 1200, clientHeight: 400, scrollTop: 500 }), false);
    assert.equal(isNearChatEnd({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true);
});

function frame(event, payload) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
}

function streamOf(text, chunkSize = 19) {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
        start(controller) {
            for (let index = 0; index < bytes.length; index += chunkSize) {
                controller.enqueue(bytes.subarray(index, index + chunkSize));
            }
            controller.close();
        },
    });
}
