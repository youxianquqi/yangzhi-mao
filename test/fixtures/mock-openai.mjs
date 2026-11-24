// Serves an HTTP SSE model on loopback only; no third-party account or credentials are needed.
import { once } from 'node:events';
import { createServer } from 'node:http';

export const contentType = { 'Content-Type': 'text/event-stream; charset=utf-8' };

/** @param {import('node:test').TestContext} t @param {import('node:http').RequestListener} listener */
export async function startOpenAIMock(t, listener) {
    const server = createServer(listener).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    }));
    return 'http://127.0.0.1:' + server.address().port;
}

/** @param {import('node:http').IncomingMessage} request */
export async function readMockRequest(request) {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    return { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(body)) };
}

/** @param {string|object} payload */
export function frame(payload) {
    return 'data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)) + '\r\n\r\n';
}

/** @param {string} [content] @param {string|null} [finishReason] */
export function delta(content, finishReason = null) {
    return { choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason }] };
}
