// Owns HTTP composition, request boundaries and safe error responses.
// Session state and write transactions live in the chat service, never in route handlers.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from './src/agents/codex.js';
import { createChatService } from './src/chat.js';
import { DEFAULT_PROVIDER, JSON_BODY_LIMIT, LIMITS, LOOPBACK_HOST, readConfig } from './src/config.js';
import { AppError, appError } from './src/errors.js';
import { createKernel } from './src/kernel.js';
import { loadEnabledPlugins } from './src/plugin-loader.js';
import { createStorageService, normalizeCharacterId } from './src/storage.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const jsonMethods = new Set(['POST', 'PUT', 'PATCH']);
const apiRoot = '/api';
const characters = apiRoot + '/characters';
const character = characters + '/:id';
const threads = character + '/threads';
const thread = threads + '/:threadId';
const threadMessages = thread + '/messages';
const jsonContentType = 'application/json';
const cacheControl = 'no-store';
const maxPendingStreamBytes = 256 * 1024;
const streamContentType = 'text/event-stream; charset=utf-8';
const contentSecurityPolicy = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** @typedef {import('./src/agents/adapter.js').AgentAdapter} AgentAdapter */
/** @typedef {import('./src/storage.js').CharacterRecord} CharacterRecord */
/** @typedef {import('./src/storage.js').StorageService} StorageService */
/** @typedef {import('./src/chat.js').ThreadView} ThreadView */
/** @typedef {import('./src/chat.js').StreamOptions} StreamOptions */
/** @typedef {{params:Record<string,string>,query:Record<string,unknown>,body:unknown}} TurnRequest */
/** @typedef {{dataDir?: string, pluginsDir?: string, agent?: AgentAdapter, storage?: StorageService, logger?: Pick<Console,'error'>}} AppOptions */

/** @param {AppOptions} [options] Standalone application without a listening socket. */
export async function createApp(options) {
    return (await createRuntime(options)).app;
}

/** @param {AppOptions} [options] Application and kernel for controlled local lifecycle operations. */
export async function createRuntime({
    dataDir = join(root, 'data'), pluginsDir = join(root, 'plugins'), agent = createCodexAdapter(), storage, logger = console,
} = {}) {
    /** @type {import('./src/kernel.js').PluginLog} */
    const log = detail => logger.error(JSON.stringify({ timestamp: new Date().toISOString(), ...detail }));
    const kernel = createKernel({ storage: storage ?? await createStorageService(dataDir), agent: { id: DEFAULT_PROVIDER, run: agent }, log });
    const chat = await createChatService({ dataDir, kernel });
    await loadEnabledPlugins(kernel, { dataDir, pluginsDir, log });

    const app = express();
    app.disable('x-powered-by');
    app.use(secureRequest);
    app.use(apiRoot, requireJson, express.json({ limit: JSON_BODY_LIMIT }));
    app.get(apiRoot + '/health', (_req, res) => res.json({ status: 'ok', agent: kernel.inject('agent').id }));
    app.get(apiRoot + '/plugins/ui', (_req, res) => res.json(kernel.getSlots()));
    registerCharacterRoutes(app, chat, logger);
    registerThreadRoutes(app, chat, logger);
    app.all(apiRoot + '/plugins/:pluginId/:resource/:id', async (req, res) => withRequestAbort(req, res, async controller => {
        const result = await kernel.dispatchRoute(req.params.pluginId, req.params.resource, req.method, {
            id: normalizeCharacterId(req.params.id), body: req.body, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!result.found) throw appError('ROUTE_NOT_FOUND');
        res.json(result.data);
    }));
    app.use(apiRoot, (_req, _res, next) => next(appError('ROUTE_NOT_FOUND')));
    app.get('/plugin-assets/:pluginId/:filename', async (req, res) => {
        const file = await kernel.asset(req.params.pluginId, req.params.filename);
        if (!file) throw appError('ROUTE_NOT_FOUND');
        res.sendFile(file, { cacheControl: false, headers: { 'Cache-Control': cacheControl } });
    });
    app.use(express.static(join(root, 'public')));
    app.use(errorHandler(logger));
    return { app, kernel };
}

function registerCharacterRoutes(app, chat, logger) {
    app.get(characters, async (_req, res) => res.json(await chat.listCharacters()));
    app.post(characters, async (req, res) => res.status(201).json(activeCharacter(await chat.createCharacter(req.body))));
    app.get(character, async (req, res) => res.json(activeCharacter(await chat.getCharacter(req.params.id))));
    app.put(character, async (req, res) => res.json(activeCharacter(await chat.editCharacter(req.params.id, req.body))));
    app.delete(character, async (req, res) => {
        await chat.deleteCharacter(req.params.id);
        res.status(204).end();
    });
    app.post(character + '/messages', async (req, res) => withRequestAbort(req, res, async controller => {
        const record = await chat.sendMessage(req.params.id, req.body, controller.signal);
        if (!controller.signal.aborted) res.json(activeCharacter(record));
    }));
    app.post(character + '/messages/stream', streamHandler((req, stream) =>
        chat.sendMessageStream(req.params.id, req.body, stream), logger));
    app.delete(character + '/session', (req, res) => withRequestAbort(req, res, async ({ signal }) => {
        const record = await chat.resetSession(req.params.id, signal);
        if (!signal.aborted) res.json(activeCharacter(record));
    }));
}

/** @param {typeof import('express').application} app @param {Awaited<ReturnType<typeof createChatService>>} chat @param {Pick<Console,'error'>} logger */
function registerThreadRoutes(app, chat, logger) {
    app.get(threads, async (req, res) => res.json(await chat.listThreads(req.params.id)));
    app.post(threads, async (req, res) => res.status(201).json(await chat.createThread(req.params.id, req.body)));
    app.get(thread, async (req, res) => res.json(threadView(await chat.getThread(req.params.id, req.params.threadId), false)));
    app.delete(thread, async (req, res) => {
        await chat.deleteThread(req.params.id, req.params.threadId);
        res.status(204).end();
    });
    app.get(threadMessages, async (req, res) => res.json(await chat.messagePage(req.params.id, req.params.threadId, {
        before: req.query.before, limit: req.query.limit,
    })));

    app.post(threadMessages, jsonThreadAction((req, signal) =>
        chat.sendThreadMessage(req.params.id, req.params.threadId, req.body, signal)));
    app.post(threadMessages + '/stream', streamHandler((req, stream) =>
        chat.sendThreadMessage(req.params.id, req.params.threadId, req.body, stream.signal, stream), logger, LIMITS.turnMessages, true));
    app.patch(threadMessages + '/:index', jsonThreadAction((req, signal) =>
        chat.editMessage(req.params.id, req.params.threadId, req.params.index, req.body, signal)));
    app.delete(threadMessages + '/:index', jsonThreadAction((req, signal) =>
        chat.truncateMessages(req.params.id, req.params.threadId, req.params.index, req.query.revision, signal)));
    app.post(threadMessages + '/regenerate', jsonThreadAction((req, signal) =>
        chat.regenerate(req.params.id, req.params.threadId, req.body, signal)));
    app.post(threadMessages + '/regenerate/stream', streamHandler((req, stream) =>
        chat.regenerate(req.params.id, req.params.threadId, req.body, stream.signal, stream), logger, 1, true));
    app.delete(thread + '/session', jsonThreadAction((req, signal) =>
        chat.resetThread(req.params.id, req.params.threadId, signal)));
}

/** @param {(req:TurnRequest, signal:AbortSignal) => Promise<ThreadView>} run */
function jsonThreadAction(run) {
    return (req, res) => withRequestAbort(req, res, async ({ signal }) => {
        const record = await run(req, signal);
        if (!signal.aborted) res.json(threadView(record, true));
    });
}

/** @param {ThreadView} record @param {boolean} includeMessages */
function threadView(record, includeMessages) {
    const { messages, ...profile } = activeCharacter(record);
    return {
        ...profile, threadId: record.threadId, threadName: record.threadName, revision: record.revision,
        messageCount: messages.length, ...(includeMessages ? { messages } : {}),
    };
}

/**
 * @param {(req:TurnRequest, stream:StreamOptions)=>Promise<ThreadView>} run
 * @param {Pick<Console,'error'>} logger @param {number} [messageCount] @param {boolean} [includeThread]
 */
function streamHandler(run, logger, messageCount = LIMITS.turnMessages, includeThread = false) {
    return (req, res) => withRequestAbort(req, res, async controller => {
        const { signal } = controller;
        try {
            const record = await run(req, {
                signal,
                onStart: () => openEventStream(res),
                onDelta: text => writeDelta(res, controller, text),
            });
            if (signal.aborted || res.destroyed) return;
            const { sessionId, messages, updatedAt, provider, threadId, revision } = record;
            res.end(eventFrame('done', {
                sessionId, messages: messages.slice(-messageCount), updatedAt, provider,
                ...(includeThread ? { threadId, revision, total: messages.length } : {}),
            }));
        } catch (error) {
            if (signal.aborted || res.destroyed) return;
            // Before lock/admission SSE headers are uncommitted, so ordinary HTTP errors remain available.
            if (!res.headersSent) throw error;
            res.end(eventFrame('error', errorPayload(error, req, res, logger)));
        }
    });
}

/** @typedef {{once:(event:'close', listener:()=>void)=>unknown, off:(event:'close', listener:()=>void)=>unknown}} Closable */
/**
 * @template T
 * @param {Closable & {complete:boolean}} req
 * @param {Closable & {writableFinished:boolean,destroyed:boolean}} res
 * @param {(controller:AbortController)=>Promise<T>} run
 */
async function withRequestAbort(req, res, run) {
    const controller = new AbortController();
    const requestClosed = () => { if (!req.complete) controller.abort(); };
    const responseClosed = () => { if (!res.writableFinished) controller.abort(); };
    req.once('close', requestClosed);
    res.once('close', responseClosed);
    if (res.destroyed) controller.abort();
    try { return await run(controller); }
    catch (error) { if (!controller.signal.aborted) throw error; }
    finally {
        req.off('close', requestClosed);
        res.off('close', responseClosed);
    }
}

function openEventStream(res) {
    res.set({
        'Content-Type': streamContentType, 'Cache-Control': cacheControl,
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
}

function writeDelta(res, controller, text) {
    if (res.destroyed || controller.signal.aborted) return;
    if (!res.write(eventFrame('delta', { text })) && res.writableLength > maxPendingStreamBytes) {
        controller.abort();
        res.destroy();
    }
}

function eventFrame(event, data) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

/** @param {CharacterRecord} record */
function activeCharacter({ id, name, description, greeting, messages, sessionId, updatedAt, provider }) {
    return { id, name, description, greeting, messages, sessionId, updatedAt, provider };
}

function secureRequest(req, res, next) {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set({
        'X-Request-Id': requestId, 'Content-Security-Policy': contentSecurityPolicy,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    if (!localRequest(req)) return next(appError('LOCAL_ONLY'));
    next();
}

function localRequest(req) {
    const host = req.get('host')?.toLowerCase();
    const port = req.socket.localPort;
    const portSuffix = port === 80 ? '' : ':' + port;
    const origin = req.get('origin');
    return (host === LOOPBACK_HOST + portSuffix || host === 'localhost' + portSuffix)
        && (!origin || origin === 'http://' + host);
}

function requireJson(req, res, next) {
    res.set('Cache-Control', cacheControl);
    if (jsonMethods.has(req.method) && !req.is(jsonContentType)) return next(appError('UNSUPPORTED_MEDIA_TYPE'));
    next();
}

function asAppError(error) {
    if (error instanceof AppError) return error;
    switch (error?.type) {
        case 'entity.parse.failed': return appError('INVALID_JSON');
        case 'entity.too.large': return appError('PAYLOAD_TOO_LARGE');
        case 'charset.unsupported':
        case 'encoding.unsupported': return appError('UNSUPPORTED_MEDIA_TYPE');
        default: return appError('INTERNAL_ERROR');
    }
}

function errorHandler(logger) {
    return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        const { status, ...body } = errorPayload(error, req, res, logger);
        res.set('Cache-Control', cacheControl);
        res.status(status).json(body);
    };
}

function errorPayload(error, req, res, logger) {
    const { status, code, message } = asAppError(error);
    const { requestId } = res.locals;
    if (status >= 500) logger.error(JSON.stringify({
        timestamp: new Date().toISOString(), event: 'request_failed', requestId, method: req.method, status, code,
    }));
    return { error: message, code, requestId, status };
}

async function start() {
    const config = readConfig(root);
    const agent = createCodexAdapter({ bin: config.codexBin, timeoutMs: config.codexTimeoutMs });
    const { app, kernel } = await createRuntime({ dataDir: config.dataDir, agent });
    const server = app.listen(config.port, LOOPBACK_HOST, () => {
        console.log('Write 已启动：http://' + LOOPBACK_HOST + ':' + config.port);
    });
    function shutdown() {
        server.close();
        server.closeAllConnections();
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.once('close', () => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        void kernel.dispose();
    });
    server.on('error', error => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        void kernel.dispose();
        console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请设置其他 PORT 后重试。' : '本地服务无法监听。');
        process.exitCode = 1;
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await start();
    } catch (error) {
        console.error('Write 无法启动：' + error.message);
        process.exitCode = 1;
    }
}
