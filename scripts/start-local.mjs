// Local, dependency-free bootstrap shared by the three double-click launchers.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/errors.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));

class LauncherError extends Error {}

function hasRuntimeDependencies() {
    if (!existsSync(join(root, 'node_modules', 'express', 'package.json'))) return false;
    try { return typeof require('express') === 'function'; }
    catch { return false; }
}

function installRuntimeDependencies() {
    const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    const nodeDir = dirname(process.execPath);
    const npmScript = [
        join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find(path => existsSync(path));
    const options = { cwd: root, stdio: 'inherit', windowsHide: true };
    console.log('首次启动或依赖不完整：正在使用 npm ci 安装依赖…');
    let result;
    if (npmScript) result = spawnSync(process.execPath, [npmScript, ...args], options);
    else if (process.platform === 'win32') {
        result = spawnSync('npm.exe', args, options);
        if (result.error?.code === 'ENOENT') {
            // The command is literal: no user values cross the batch shell.
            result = spawnSync('cmd.exe', ['/d', '/c', 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'], options);
        }
    } else result = spawnSync('npm', args, options);
    if (result.status !== 0) {
        throw new LauncherError('未能安装依赖。请确认 Node.js 自带的 npm 可用、网络可连接 npm，或下载预装依赖的便携版。');
    }
}

async function openBrowser(url) {
    switch (process.platform) {
        case 'win32':
            if (await tryOpen('rundll32.exe', ['url.dll,FileProtocolHandler', url])) return;
            break;
        case 'darwin':
            if (await tryOpen('open', [url])) return;
            break;
        default:
            if (await tryOpen('xdg-open', [url]) || await tryOpen('gio', ['open', url])) return;
    }
    console.log('无法自动打开浏览器，请手动访问：' + url);
}

function tryOpen(executable, args) {
    return new Promise(resolve => {
        const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => resolve(false));
        child.once('exit', code => resolve(code === 0));
        child.unref();
    }).catch(() => false);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    if ([...args].some(arg => arg !== '--safe-mode' && arg !== '--no-browser')) {
        throw new LauncherError('启动参数无效。可使用 --safe-mode 或 --no-browser。');
    }
    if (args.has('--safe-mode')) process.env.SAFE_MODE = '1';
    if (!hasRuntimeDependencies()) installRuntimeDependencies();
    const { start } = await import('../server.js');
    await start(url => {
        if (!args.has('--no-browser') && process.env.WRITE_NO_BROWSER !== '1') void openBrowser(url);
    });
}

try {
    await main();
} catch (error) {
    const detail = error instanceof AppError || error instanceof LauncherError ? error.message : '请检查本机环境及设置。';
    console.error('Write 无法启动：' + detail);
    process.exitCode = 1;
}
