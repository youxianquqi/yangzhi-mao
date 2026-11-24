// Same-origin streaming client. UTF-8 decoder and SSE framing are kept outside the DOM.
// Events never become HTML; a validated done event is the only successful result.

import { validRevision } from './thread-state.js';

const eventStreamType = 'text/event-stream';
const maxEventChars = 512 * 1024;
const maxPreviewChars = 64 * 1024;
const invalidStream = '服务返回了无效的回复流。';
const interruptedStream = '回复流意外中断，未收到保存确认。请刷新核对记录后再试。';

/** @typedef {import('./state.js').CommittedTurn} CommittedTurn */
/** @typedef {{signal: AbortSignal, onDelta: (text: string) => void, onRequestId?: (requestId: string|null) => void}} StreamOptions */
/** @typedef {{mode?: 'pair'|'regenerate', threadId?: string}} CommitExpectation */
/** @typedef {{buffer: string, event: string, data: string[], dataChars: number, previewChars: number, expectation: CommitExpectation}} EventBuffer */

/**
 * @param {string} url 同源 POST 端点。
 * @param {string} message 本轮用户输入。
 * @param {StreamOptions} options
 * @returns {Promise<CommittedTurn>}
 */
export async function requestChatTurn(url, message, options) {
    return requestStream(url, { message }, options, {});
}

/**
 * @param {string} url
 * @param {{message?: string, revision: string}} body
 * @param {StreamOptions & {threadId: string, mode: 'pair'|'regenerate'}} options
 * @returns {Promise<CommittedTurn>}
 */
export async function requestThreadTurn(url, body, options) {
    return requestStream(url, body, options, { threadId: options.threadId, mode: options.mode });
}

/** @param {string} url @param {unknown} body @param {StreamOptions} options @param {CommitExpectation} expectation */
async function requestStream(url, body, { signal, onDelta, onRequestId }, expectation) {
    const response = await fetchChatStream(url, body, signal);
    const requestId = response.headers.get('X-Request-Id');
    onRequestId?.(requestId);
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        signal.throwIfAborted();
        throw new Error(withRequestId(payload?.error || '本地服务没有接受本轮请求。', payload?.requestId || requestId));
    }
    if (!response.body || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== eventStreamType) {
        throw new Error(withRequestId(invalidStream, requestId));
    }
    try {
        const turn = await readChatStream(response.body, onDelta, expectation);
        signal.throwIfAborted();
        return turn;
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof StreamError) throw new Error(withRequestId(error.message, error.requestId || requestId));
        throw new Error(withRequestId(interruptedStream, requestId));
    }
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(text: string) => void} onDelta
 * @param {CommitExpectation} [expectation]
 * @returns {Promise<CommittedTurn>}
 */
export async function readChatStream(body, onDelta, expectation = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    /** @type {EventBuffer} */
    const state = { buffer: '', event: '', data: [], dataChars: 0, previewChars: 0, expectation };
    try {
        while (true) {
            const { value, done } = await reader.read();
            const turn = processChunk(state, decodeChunk(decoder, value, !done), onDelta, done);
            if (turn) return turn;
            if (done) throw new StreamError(interruptedStream);
        }
    } finally {
        // The terminal event is sufficient; don't hold the reader waiting for TCP close.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/**
 * @param {string} message
 * @param {string|null} [requestId]
 * @returns {string}
 */
export function withRequestId(message, requestId) {
    const detail = typeof message === 'string' && message ? message : '本地服务没有返回有效响应。';
    return typeof requestId === 'string' && requestId ? detail + '（请求编号：' + requestId + '）' : detail;
}

class StreamError extends Error {
    /** @param {string} message @param {string|null} [requestId] */
    constructor(message, requestId = null) {
        super(message);
        this.requestId = requestId;
    }
}

/** @param {string} url @param {unknown} body @param {AbortSignal} signal */
async function fetchChatStream(url, body, signal) {
    try {
        return await fetch(url, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', Accept: eventStreamType },
            body: JSON.stringify(body),
        });
    } catch {
        signal.throwIfAborted();
        throw new Error('无法连接本地服务，请确认它仍在运行。');
    }
}

/** @param {TextDecoder} decoder @param {Uint8Array|undefined} chunk @param {boolean} stream */
function decodeChunk(decoder, chunk, stream) {
    try {
        return decoder.decode(chunk, { stream });
    } catch {
        throw new StreamError(invalidStream);
    }
}

/** @param {EventBuffer} state @param {string} text @param {(text: string) => void} onDelta @param {boolean} isFinal @returns {CommittedTurn|null} */
function processChunk(state, text, onDelta, isFinal) {
    state.buffer += text;
    let from = 0;
    // Defer a trailing CR so the following LF, if any, belongs to it even across reads.
    const breaks = isFinal ? /\r\n|\r|\n/g : /\r\n|\r(?!$)|\n/g;
    for (const match of state.buffer.matchAll(breaks)) {
        const end = match.index ?? 0;
        const line = state.buffer.slice(from, end);
        if (line.length > maxEventChars) throw new StreamError(invalidStream);
        const turn = processLine(state, line, onDelta);
        if (turn) return turn;
        from = end + match[0].length;
    }
    state.buffer = state.buffer.slice(from);
    if (state.buffer.length > maxEventChars) throw new StreamError(invalidStream);
    return null;
}

/** @param {EventBuffer} state @param {string} line @param {(text: string) => void} onDelta @returns {CommittedTurn|null} */
function processLine(state, line, onDelta) {
    if (!line) {
        const event = state.event;
        const data = state.data.join('\n');
        state.event = '';
        state.data = [];
        state.dataChars = 0;
        return data ? parseEvent(event, data, state, onDelta) : null;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') state.event = value;
    if (field !== 'data') return null;
    state.dataChars += value.length + 1;
    if (state.dataChars > maxEventChars) throw new StreamError(invalidStream);
    state.data.push(value);
    return null;
}

/** @param {string} event @param {string} value @param {EventBuffer} state @param {(text: string) => void} onDelta @returns {CommittedTurn|null} */
function parseEvent(event, value, state, onDelta) {
    if (!['delta', 'done', 'error'].includes(event)) return null;
    let payload;
    try {
        payload = JSON.parse(value);
    } catch {
        throw new StreamError(invalidStream);
    }
    if (event === 'error') {
        throw new StreamError(typeof payload?.error === 'string' ? payload.error : invalidStream, payload?.requestId);
    }
    if (event === 'delta') {
        if (typeof payload?.text !== 'string') throw new StreamError(invalidStream);
        state.previewChars += payload.text.length;
        if (state.previewChars > maxPreviewChars) throw new StreamError(invalidStream);
        if (payload.text) onDelta(payload.text);
        return null;
    }
    if (!isCommittedTurn(payload, state.expectation)) throw new StreamError(invalidStream);
    return payload;
}

/** @param {any} value @param {CommitExpectation} expectation @returns {value is CommittedTurn} */
function isCommittedTurn(value, { mode, threadId }) {
    if (typeof value?.sessionId !== 'string' || !value.sessionId.trim()
        || typeof value.updatedAt !== 'string' || !value.updatedAt
        || (value.provider !== undefined && (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider)))
        || !Array.isArray(value.messages)) return false;
    if (threadId !== undefined && (value.threadId !== threadId || !validRevision(value.revision)
        || !Number.isSafeInteger(value.total) || value.total < value.messages.length)) return false;
    const assistant = value.messages.at(-1);
    if (assistant?.role !== 'assistant' || typeof assistant.text !== 'string' || !assistant.text.trim()) return false;
    if (mode === 'regenerate') return value.messages.length === 1;
    return value.messages.length === 2 && value.messages[0]?.role === 'user' && typeof value.messages[0].text === 'string';
}
