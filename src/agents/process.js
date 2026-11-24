// Streams bounded JSONL from one shell-free process; stdout and stderr are never logged.
// Cancellation stops the owned tree and waits for close before the chat layer releases its lock.

import { execFile, spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { LIMITS } from '../config.js';
import { appError } from '../errors.js';

const WINDOWS = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 10_000;
const MAX_TEARDOWN_MS = TASKKILL_TIMEOUT_MS + 1000;

/** @typedef {import('node:child_process').ChildProcessWithoutNullStreams} AgentChild */
/** @typedef {NodeJS.ErrnoException} ProcessError */
/** @typedef {Record<string, unknown>} JsonlEvent */
/** @typedef {{error: ProcessError|null, stderr: string}} ProcessResult */

/**
 * @typedef {object} JsonlProcessRequest
 * @property {string} file
 * @property {string[]} args
 * @property {string} cwd
 * @property {number} timeoutMs
 * @property {string} payload
 * @property {AbortSignal} [signal]
 * @property {(event: JsonlEvent) => void} onEvent
 */

/**
 * @param {JsonlProcessRequest} request
 * @returns {Promise<ProcessResult>}
 */
export async function runJsonlProcess(request) {
    if (request.signal?.aborted) throw appError('STREAM_ABORTED');
    let child;
    try {
        child = spawn(request.file, request.args, {
            cwd: request.cwd, shell: false, windowsHide: true, detached: !WINDOWS,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        // Some Windows startup failures throw synchronously instead of emitting an error.
        return { error: error instanceof Error ? error : new Error('Unable to start CLI'), stderr: '' };
    }
    return monitorProcess(child, request);
}

/** @param {unknown} value @returns {value is JsonlEvent} */
export function isJsonlObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {AgentChild} child @param {JsonlProcessRequest} request @returns {Promise<ProcessResult>} */
function monitorProcess(child, { signal, timeoutMs, payload, onEvent }) {
    return new Promise((resolve, reject) => {
        let failure, startError, teardown, teardownTimer;
        /** @param {unknown} error */
        const stop = error => {
            if (failure) return;
            failure = error;
            teardown = stopTree(child).catch(() => killChild(child));
            // Descendants that the OS refuses to kill may keep inherited pipes open indefinitely.
            // Abandon the failed transport rather than holding the role lock forever.
            teardownTimer = setTimeout(() => {
                dispose();
                killChild(child);
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                reject(failure);
            }, MAX_TEARDOWN_MS);
        };
        const abort = () => stop(appError('STREAM_ABORTED'));
        const timer = setTimeout(() => stop(appError('AGENT_TIMEOUT')), timeoutMs);
        const stdout = createJsonlReader(event => { if (!failure) onEvent(event); });
        const stderr = collectStderr(child.stderr, stop);
        child.once('error', error => { startError = error; });
        child.stdout.on('data', chunk => {
            if (failure) return;
            try { stdout.push(chunk); } catch (error) { stop(error); }
        });
        child.once('close', async (code, exitSignal) => {
            try {
                await teardown;
                dispose();
                if (failure) throw failure;
                if (!startError) stdout.finish();
                resolve({ error: startError ?? (code === 0 ? null : new Error(exitSignal ?? 'CLI exited')), stderr: stderr() });
            } catch (error) {
                reject(error);
            }
        });
        signal?.addEventListener('abort', abort, { once: true });
        child.stdin.on('error', () => {}); // Startup and partial writes resolve via close; never echo input.
        if (signal?.aborted) abort();
        else child.stdin.end(payload, 'utf8');

        function dispose() {
            clearTimeout(timer);
            clearTimeout(teardownTimer);
            signal?.removeEventListener('abort', abort);
        }
    });
}

/** @param {JsonlProcessRequest['onEvent']} onEvent */
function createJsonlReader(onEvent) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, pending = '';
    return {
        push(chunk) {
            bytes += chunk.length;
            if (bytes > LIMITS.codexOutputBytes) throw appError('AGENT_OUTPUT_TOO_LARGE');
            consume(decode(decoder, chunk, { stream: true }));
        },
        finish() {
            consume(decode(decoder));
            emit(pending);
        },
    };

    function consume(text) {
        const lines = (pending + text).split('\n');
        pending = lines.pop();
        for (const line of lines) emit(line);
    }

    function emit(line) {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { throw appError('AGENT_PROTOCOL'); }
        if (!isJsonlObject(event)) throw appError('AGENT_PROTOCOL');
        onEvent(event);
    }
}

/** @param {TextDecoder} decoder @param {Uint8Array} [chunk] @param {TextDecodeOptions} [options] */
function decode(decoder, chunk, options) {
    try { return decoder.decode(chunk, options); } catch { throw appError('AGENT_PROTOCOL'); }
}

/** @param {AgentChild['stderr']} stream @param {(cause: unknown) => void} stop */
function collectStderr(stream, stop) {
    let bytes = 0;
    const chunks = [];
    stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LIMITS.codexOutputBytes) stop(appError('AGENT_OUTPUT_TOO_LARGE'));
        else chunks.push(chunk);
    });
    return () => Buffer.concat(chunks).toString('utf8');
}

/** @param {AgentChild} child */
async function stopTree(child) {
    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return;
    if (!WINDOWS) {
        // detached creates this exact process group; SIGKILL also closes descendant-held pipes.
        try { process.kill(-pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') killChild(child);
        }
        return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot)) {
        killChild(child);
        return;
    }
    await new Promise(resolve => {
        // Only target the spawned PID; use the system executable, never a PATH shim or a shell.
        execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
            { shell: false, windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, error => {
                if (error && child.exitCode === null && child.signalCode === null) killChild(child);
                resolve(undefined);
            });
    });
}

/** @param {AgentChild} child */
function killChild(child) {
    try { child.kill('SIGKILL'); } catch { /* OS-denied cleanup cannot make a turn successful. */ }
}
