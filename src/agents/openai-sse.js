// Bounded OpenAI Chat Completions SSE decoder; excludes thought and tool events.
// Valid completion requires both finish_reason=stop and the [DONE] event.
import { LIMITS } from '../config.js';
import { appError } from '../errors.js';

const responseLimitBytes = 4 * 1024 * 1024;
const eventLimitChars = 512 * 1024;
const eventStreamType = 'text/event-stream';

/** @typedef {{buffer: string, event: string, data: string[], dataChars: number, skipLF: boolean, reply: string, stopped: boolean, probe: boolean}} StreamState */

/**
 * @param {Response} response
 * @param {(text: string) => void} [onDelta]
 * @param {boolean} [probe] Test transport without waiting for the model to finish.
 * @returns {Promise<string>}
 */
export async function readCompletion(response, onDelta, probe = false) {
    const body = response.body;
    if (!response.ok || !body || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== eventStreamType) {
        void body?.cancel().catch(() => {});
        if (response.status === 429) throw appError('AGENT_RATE_LIMITED');
        if (response.status === 401 || response.status === 403) {
            throw appError('AGENT_UNAVAILABLE', { message: '模型拒绝了请求，请核对接口地址与密钥权限。' });
        }
        throw appError(response.ok ? 'AGENT_PROTOCOL' : 'AGENT_UNAVAILABLE');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    /** @type {StreamState} */
    const state = { buffer: '', event: '', data: [], dataChars: 0, skipLF: false, reply: '', stopped: false, probe };
    let bytes = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            bytes += value?.byteLength ?? 0;
            if (bytes > responseLimitBytes) throw appError('AGENT_OUTPUT_TOO_LARGE');
            if (consume(state, decode(decoder, value, !done), onDelta)) return state.reply;
            if (done) throw incomplete();
        }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/**
 * @param {TextDecoder} decoder
 * @param {Uint8Array|undefined} input
 * @param {boolean} stream
 */
function decode(decoder, input, stream) {
    try {
        return decoder.decode(input, { stream });
    } catch {
        throw appError('AGENT_PROTOCOL');
    }
}

/**
 * @param {StreamState} state
 * @param {string} text
 * @param {((text: string) => void)|undefined} onDelta
 * @returns {boolean}
 */
function consume(state, text, onDelta) {
    if (!text) return false;
    if (state.skipLF && text.startsWith('\n')) text = text.slice(1);
    state.skipLF = false;
    let offset = 0;
    // Scan new text once; an LF arriving after a trailing CR belongs to that same line break.
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        const line = state.buffer + text.slice(offset, match.index);
        state.buffer = '';
        offset = match.index + match[0].length;
        state.skipLF = match[0] === '\r' && offset === text.length;
        if (line.length > eventLimitChars) throw appError('AGENT_OUTPUT_TOO_LARGE');
        if (consumeLine(state, line, onDelta)) return true;
    }
    state.buffer += text.slice(offset);
    if (state.buffer.length > eventLimitChars) throw appError('AGENT_OUTPUT_TOO_LARGE');
    return false;
}

/**
 * @param {StreamState} state
 * @param {string} line
 * @param {((text: string) => void)|undefined} onDelta
 * @returns {boolean}
 */
function consumeLine(state, line, onDelta) {
    if (!line) {
        const value = state.data.join('\n');
        const event = state.event;
        state.event = '';
        state.data = [];
        state.dataChars = 0;
        if (event === 'error') throw appError('AGENT_UNAVAILABLE');
        return Boolean(value) && receive(state, value, onDelta);
    }
    if (line.startsWith(':')) return false;
    const colon = line.indexOf(':');
    const key = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') state.event = value;
    if (key !== 'data') return false;
    state.dataChars += value.length + 1;
    if (state.dataChars > eventLimitChars) throw appError('AGENT_OUTPUT_TOO_LARGE');
    state.data.push(value);
    return false;
}

/**
 * @param {StreamState} state
 * @param {string} raw
 * @param {((text: string) => void)|undefined} onDelta
 * @returns {boolean}
 */
function receive(state, raw, onDelta) {
    if (raw === '[DONE]') {
        if (!state.stopped || !state.reply.trim()) throw incomplete();
        return true;
    }
    const payload = parsePayload(raw);
    if (payload.error != null) throw appError('AGENT_UNAVAILABLE');
    const choices = payload.choices;
    if (!Array.isArray(choices)) throw appError('AGENT_PROTOCOL');
    // Heartbeat and usage events carry no choice and never advance completion.
    if (choices.length === 0) return false;
    if (choices.length !== 1 || state.stopped) throw appError('AGENT_PROTOCOL');
    const choice = choices[0];
    if (!isObject(choice) || choice.index !== 0 || !isObject(choice.delta)) throw appError('AGENT_PROTOCOL');
    const reason = choice.finish_reason;
    if (reason != null && reason !== 'stop' && !(state.probe && reason === 'length')) throw incomplete();
    const text = readText(choice.delta);
    if (state.probe) return true;
    if (state.reply.length + text.length > LIMITS.replyLength) throw appError('AGENT_REPLY_TOO_LONG');
    state.reply += text;
    if (text) onDelta?.(text);
    state.stopped = reason === 'stop';
    return false;
}

/** @param {Record<string, unknown>} delta @returns {string} */
function readText(delta) {
    const { content, tool_calls, function_call, server_tool_calls, server_tool_event, refusal } = delta;
    if ([tool_calls, server_tool_calls].some(value => value != null && (!Array.isArray(value) || value.length))
        || function_call != null || server_tool_event != null || refusal) throw incomplete();
    if (content == null) return '';
    if (typeof content !== 'string') throw appError('AGENT_PROTOCOL');
    return content;
}

/** @param {string} raw @returns {Record<string, unknown>} */
function parsePayload(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw appError('AGENT_PROTOCOL');
    }
    if (!isObject(value)) throw appError('AGENT_PROTOCOL');
    return value;
}

function incomplete() {
    return appError('AGENT_INCOMPLETE', { message: '模型未完整结束文本回复，未保存本轮。' });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
