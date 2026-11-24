import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native launcher starts on the configured loopback port without a browser or npm install', { timeout: 15_000 }, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-launcher-test-'));
    const port = await freePort();
    const url = 'http://127.0.0.1:' + port;
    const windows = process.platform === 'win32';
    const env = {
        ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH,
        PORT: String(port), DATA_DIR: dataDir, WRITE_AGENT: '', SAFE_MODE: '0',
        WRITE_NO_BROWSER: '1', WRITE_NO_PAUSE: '1',
    };
    const flags = ['--safe-mode', '--no-browser'];
    const child = windows
        ? spawn('cmd.exe', ['/d', '/c', 'start.bat', ...flags], { cwd: root, env, windowsHide: true })
        : spawn('/bin/sh', [process.platform === 'darwin' ? 'start.command' : 'start.sh', ...flags], { cwd: root, env, detached: true });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const closed = once(child, 'close').catch(() => []);
    t.after(async () => {
        try {
            if (child.pid && child.exitCode === null && child.signalCode === null) {
                if (windows) {
                    await new Promise(resolve => {
                        execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, resolve);
                    });
                } else {
                    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                }
            }
            await closed;
        } finally {
            await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
        }
    });

    await waitUntilReady(child, () => output, url);
    assert.doesNotMatch(output, /npm ci/);
    const settings = await fetch(url + '/api/settings', { signal: AbortSignal.timeout(3000) });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).safeMode, true);
});

async function freePort() {
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return port;
}

function waitUntilReady(child, output, url) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Launcher did not become ready:\n' + output())), 10_000);
        const onClose = code => finish(new Error('Launcher exited with ' + code + ':\n' + output()));
        const onData = () => { if (output().includes(url)) finish(); };
        child.once('close', onClose);
        child.once('error', finish);
        child.stdout.on('data', onData);
        function finish(error) {
            clearTimeout(timer);
            child.off('close', onClose);
            child.off('error', finish);
            child.stdout.off('data', onData);
            if (error) reject(error);
            else resolve();
        }
    });
}
