import express from 'express';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexCommand, runCodex } from './src/agents/codex.js';
import { createChatService } from './src/chat.js';
import { readConfig } from './src/config.js';
import { AppError } from './src/errors.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const loopback = '127.0.0.1';
const jsonMethods = new Set(['POST', 'PUT']);

function localRequest(req) {
    const host = req.get('host')?.toLowerCase();
    const port = req.socket.localPort;
    const portSuffix = port === 80 ? '' : ':' + port;
    const origin = req.get('origin');
    return (host === loopback + portSuffix || host === 'localhost' + portSuffix)
        && (!origin || origin === 'http://' + host);
}

function asAppError(error) {
    if (error instanceof AppError) return error;
    if (error.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', '请求中的 JSON 无效。');
    if (error.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', '请求内容太长。');
    if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
        return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求的字符集或编码不受支持。');
    }
    return new AppError(500, 'INTERNAL_ERROR', '本地服务出错，请查看启动终端。');
}

export async function createApp({ dataDir = join(root, 'data'), agent = runCodex, logger = console } = {}) {
    const chat = await createChatService({ dataDir, agent });
    const app = express();
    app.disable('x-powered-by');

    app.use((req, res, next) => {
        const requestId = randomUUID();
        res.locals.requestId = requestId;
        res.set('X-Request-Id', requestId);
        res.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        if (!localRequest(req)) return next(new AppError(403, 'LOCAL_ONLY', '此应用只接受来自本机页面的请求。'));
        next();
    });

    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (jsonMethods.has(req.method) && !req.is('application/json')) {
            return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 JSON。'));
        }
        next();
    }, express.json({ limit: '64kb' }));

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', agent: 'codex' }));
    app.get('/api/characters', async (_req, res) => res.json(await chat.listCharacters()));
    app.post('/api/characters', async (req, res) => res.status(201).json(await chat.createCharacter(req.body)));
    app.get('/api/characters/:id', async (req, res) => res.json(await chat.getCharacter(req.params.id)));
    app.put('/api/characters/:id', async (req, res) => res.json(await chat.editCharacter(req.params.id, req.body)));
    app.post('/api/characters/:id/messages', async (req, res) => res.json(await chat.sendMessage(req.params.id, req.body)));
    app.delete('/api/characters/:id/session', async (req, res) => res.json(await chat.resetSession(req.params.id)));

    app.use('/api', (_req, _res, next) => next(new AppError(404, 'ROUTE_NOT_FOUND', '接口不存在。')));
    app.use(express.static(join(root, 'public')));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const { status, code, message } = asAppError(error);
        const { requestId } = res.locals;
        if (status >= 500) logger.error(JSON.stringify({
            timestamp: new Date().toISOString(), event: 'request_failed', requestId, method: req.method, status, code,
        }));
        res.set('Cache-Control', 'no-store');
        res.status(status).json({ error: message, code, requestId });
    });
    return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const config = readConfig(root);
        const command = resolveCodexCommand(config.codexBin);
        const app = await createApp({
            dataDir: config.dataDir,
            agent: options => runCodex({ ...options, command, timeoutMs: config.codexTimeoutMs }),
        });
        const server = app.listen(config.port, loopback, () => {
            console.log('Write 已启动：http://' + loopback + ':' + config.port);
        });
        server.on('error', error => {
            console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请设置其他 PORT 后重试。' : '本地服务无法监听。');
            process.exitCode = 1;
        });
    } catch (error) {
        console.error('Write 无法启动：' + error.message);
        process.exitCode = 1;
    }
}
