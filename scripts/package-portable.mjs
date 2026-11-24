// Build with trusted official Node binaries and npm ci's already-installed lockfile dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const platforms = new Set(['win32', 'darwin', 'linux']);
const architectures = new Set(['x64', 'arm64']);
const builtins = ['_template', 'agent-antigravity', 'agent-openai-compat', 'card-importer', 'persona-guard', 'story-clues'];
export const usage = '用法：node scripts/package-portable.mjs --runtime <官方 Node.js 解压目录> --out <产物目录>'
    + ' [--platform win32|darwin|linux] [--arch x64|arm64]';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length === 3 && process.argv[2] === '--help') {
            console.log(usage);
        } else {
            await main(process.argv.slice(2));
        }
    } catch (error) {
        console.error('便携版打包失败：' + error.message);
        process.exitCode = 1;
    }
}

export async function main(args) {
    const cli = parseArgs(args);
    const platform = cli.get('--platform') ?? process.platform;
    const arch = cli.get('--arch') ?? process.arch;
    if (!platforms.has(platform) || !architectures.has(arch)) throw new Error(usage);
    if (platform !== process.platform || arch !== process.arch) {
        throw new Error('请在对应系统和架构的发布机上打包（当前 ' + process.platform + '/' + process.arch + '）。');
    }

    const runtime = resolve(cli.get('--runtime'));
    const output = resolve(cli.get('--out'));
    const windows = platform === 'win32';
    const binaryName = windows ? 'node.exe' : 'bin/node';
    const binary = await checkedPath(runtime, binaryName, 'file');
    await checkedPath(runtime, 'LICENSE', 'file');
    validateRuntime(binary, platform, arch);
    const { version } = await readJson(await checkedPath(root, 'package.json', 'file'));
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) {
        throw new Error('package.json 的 version 无效。');
    }

    await mkdir(output, { recursive: true });
    await checkedPath(output, '', 'directory');
    const label = 'Write-' + version + '-' + platform + '-' + arch;
    const archive = label + (windows ? '.zip' : '.tar.gz');
    const staging = await mkdtemp(join(output, '.write-portable-'));
    if (dirname(resolve(staging)) !== output || !basename(staging).startsWith('.write-portable-')) {
        throw new Error('打包暂存目录不在指定产物目录内。');
    }
    try {
        const destination = join(staging, label);
        await mkdir(destination);
        await copyProject(destination);
        await copyDependencies(destination);
        await copySelected(runtime, join(destination, 'runtime'), binaryName);
        await copySelected(runtime, join(destination, 'runtime'), 'LICENSE');
        if (!windows) await chmod(join(destination, 'runtime', binaryName), 0o755);

        const temporaryArchive = join(staging, archive);
        execFileSync(windows ? 'tar.exe' : 'tar', [windows ? '-acf' : '-czf', temporaryArchive, '-C', staging, label], {
            env: { ...process.env, TAR_OPTIONS: '' }, stdio: 'inherit', windowsHide: true, timeout: 120_000,
        });

        const digest = await computeFileSha256(temporaryArchive);
        const checksumName = archive + '.sha256';
        const temporaryChecksum = join(staging, checksumName);
        await writeFile(temporaryChecksum, `${digest}  ${archive}\n`, { flag: 'wx' });

        // A complete archive and checksum appear together; an existing release is never overwritten.
        const result = join(output, archive);
        const resultChecksum = join(output, checksumName);
        try {
            await link(temporaryArchive, result);
        } catch (cause) {
            if (cause?.code === 'EEXIST') throw new Error('产物已存在：' + result);
            throw cause;
        }
        try {
            await link(temporaryChecksum, resultChecksum);
        } catch (cause) {
            await rm(result, { force: true });
            if (cause?.code === 'EEXIST') throw new Error('产物已存在：' + resultChecksum);
            throw cause;
        }
        console.log('便携版已生成：' + result);
        console.log('校验和已生成：' + resultChecksum);
    } finally {
        // Staging is the exact directory returned by mkdtemp, not a user-provided deletion path.
        await rm(staging, { recursive: true, force: true });
    }
}

export function parseArgs(args) {
    const cli = new Map();
    const flags = new Set(['--runtime', '--out', '--platform', '--arch']);
    for (let i = 0; i < args.length; i += 2) {
        const [flag, value] = [args[i], args[i + 1]];
        if (!flags.has(flag) || !value || value.startsWith('--') || cli.has(flag)) throw new Error(usage);
        cli.set(flag, value);
    }
    if (!cli.has('--runtime') || !cli.has('--out')) throw new Error(usage);
    return cli;
}

export function validateRuntime(binary, platform, arch) {
    const details = execFileSync(binary, ['-p', 'JSON.stringify([process.platform,process.arch,process.versions.node])'], {
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const [actualPlatform, actualArch, version] = JSON.parse(details);
    if (actualPlatform !== platform || actualArch !== arch || typeof version !== 'string'
        || !/^\d+\.\d+\.\d+/.test(version) || Number(version.split('.')[0]) < 22) {
        throw new Error('指定的运行时须为对应平台和架构的 Node.js 22 或更高版本。');
    }
}

export async function computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function copyProject(dest) {
    for (const file of [
        'LICENSE', 'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'server.js',
        'start.bat', 'scripts/start-local.mjs',
    ]) await copySelected(root, dest, file);
    for (const script of ['start.command', 'start.sh']) {
        const source = await checkedPath(root, script, 'file');
        await writeFile(join(dest, script), (await readFile(source, 'utf8')).replace(/\r\n/g, '\n'), { flag: 'wx', mode: 0o755 });
        await chmod(join(dest, script), 0o755);
    }
    for (const [dir, files] of [
        ['src', /\.(?:js|mjs)$/], ['public', /\.(?:js|mjs|html|css)$/], ['docs', /\.md$/],
        ...builtins.map(id => ['plugins/' + id, /(?:^plugin\.json$|\.(?:js|mjs|css)$)/]),
    ]) await copyTree(await checkedPath(root, dir, 'directory'), join(dest, dir), name => files.test(name));
}

async function copyDependencies(dest) {
    const lock = await readJson(await checkedPath(root, 'package-lock.json', 'file'));
    if (lock.lockfileVersion !== 3 || !lock.packages?.['']?.dependencies?.express) {
        throw new Error('package-lock.json 缺少受支持的生产依赖锁定信息。');
    }
    const entries = Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev);
    for (const [path, pkg] of entries) {
        // npm lock paths can include scoped and nested dependencies, never traversals or links.
        const part = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+';
        const packagePath = new RegExp('^(?:node_modules/' + part + '/)*node_modules/' + part + '$', 'i');
        if (!packagePath.test(path) || path.split('/').some(name => name === '..' || name === '.') || pkg.link) {
            throw new Error('便携包不支持此生产依赖路径：' + path);
        }
        let source;
        try {
            source = await checkedPath(root, path, 'directory');
        } catch (cause) {
            if (cause?.code === 'ENOENT' && pkg.optional) continue;
            if (cause?.code === 'ENOENT') throw new Error('缺少生产依赖，请先运行 npm ci：' + path);
            throw cause;
        }
        const installed = await readJson(await checkedPath(source, 'package.json', 'file'));
        if (installed.version !== pkg.version) throw new Error('生产依赖版本与锁文件不符，请先运行 npm ci：' + path);
        await copyTree(source, join(dest, path), name => !['secrets.json', 'config.yaml', 'config.yml'].includes(name.toLowerCase()));
    }
}

async function checkedPath(base, relative, finalKind) {
    let current = base;
    const components = ['', ...relative.split('/').filter(Boolean)];
    for (const [index, component] of components.entries()) {
        if (component) current = join(current, component);
        const metadata = await lstat(current);
        const last = index === components.length - 1;
        if (last && finalKind === 'file' ? !metadata.isFile() : !metadata.isDirectory()) {
            throw new Error('需要普通文件或目录（不接受链接）：' + current);
        }
    }
    return current;
}

async function copySelected(base, dest, file) {
    const source = await checkedPath(base, file, 'file');
    const target = join(dest, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
}

async function copyTree(source, dest, include) {
    await mkdir(dest, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
        // Scope recursion to published code/dependencies, leaving user state and linked paths out.
        if (name.startsWith('.') || ['data', 'node_modules'].includes(name.toLowerCase())) continue;
        const path = join(source, name);
        const metadata = await lstat(path);
        if (metadata.isDirectory()) await copyTree(path, join(dest, name), include);
        else if (metadata.isFile() && include(name)) await copyFile(path, join(dest, name));
        else if (metadata.isSymbolicLink()) throw new Error('便携包不复制符号链接：' + path);
    }
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}
