// Smoke test for generated portable archive without depending on third-party tools.
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} archivePath
 * @returns {Promise<void>}
 */
export async function smokeTestPortable(archivePath) {
    const archive = resolve(archivePath);
    if (!archive) throw new Error('请指定便携包路径。');
    const isWindows = process.platform === 'win32';
    const tempDir = await mkdtemp(join(tmpdir(), 'write-smoke-test-'));
    try {
        console.log('解压便携包进行冒烟验证：' + archive);
        if (isWindows) {
            execFileSync('tar.exe', ['-xf', archive, '-C', tempDir], { stdio: 'inherit', windowsHide: true });
        } else {
            execFileSync('tar', ['-xzf', archive, '-C', tempDir], { stdio: 'inherit' });
        }

        const entries = await readdir(tempDir);
        const appDirName = entries.find(name => !name.startsWith('.'));
        if (!appDirName) throw new Error('解压产物为空。');
        const appDir = join(tempDir, appDirName);

        const nodeBinary = isWindows ? join(appDir, 'runtime', 'node.exe') : join(appDir, 'runtime', 'bin', 'node');
        const stat = await lstat(nodeBinary);
        if (!stat.isFile()) throw new Error('缺少内置 Node 运行时：' + nodeBinary);

        const port = await getFreePort();
        const dataDir = join(tempDir, 'smoke-data');
        await mkdir(dataDir, { recursive: true });

        console.log('使用内置运行时启动服务：' + nodeBinary + ' (port ' + port + ')');
        const child = spawn(nodeBinary, ['scripts/start-local.mjs', '--no-browser'], {
            cwd: appDir,
            env: {
                ...process.env,
                PORT: String(port),
                DATA_DIR: dataDir,
                WRITE_NO_BROWSER: '1',
                WRITE_NO_PAUSE: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let output = '';
        child.stdout?.setEncoding('utf8').on('data', d => { output += d; });
        child.stderr?.setEncoding('utf8').on('data', d => { output += d; });

        try {
            const healthUrl = 'http://127.0.0.1:' + port + '/api/health';
            let ready = false;
            for (let attempt = 0; attempt < 40; attempt++) {
                await new Promise(r => setTimeout(r, 250));
                try {
                    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
                    if (res.status === 200) {
                        const json = await res.json();
                        if (json?.status === 'ok') {
                            ready = true;
                            console.log('冒烟测试成功：GET /api/health 返回 200 ok (agent: ' + json.agent + ')');
                            break;
                        }
                    }
                } catch {}
            }
            if (!ready) {
                throw new Error('便携版启动超时，未能访问 /api/health。\n服务输出：\n' + output);
            }
        } finally {
            child.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 800));
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
        }
    } finally {
        await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
}

async function getFreePort() {
    /** @type {import('node:net').Server} */
    const s = createServer().listen(0, '127.0.0.1');
    await new Promise(r => s.once('listening', r));
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise(r => s.close(r));
    return port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const archive = process.argv[2];
    if (!archive) {
        console.error('用法：node scripts/smoke-portable.mjs <便携包路径>');
        process.exit(1);
    }
    try {
        await smokeTestPortable(archive);
    } catch (err) {
        console.error('便携版冒烟测试失败：' + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
}
