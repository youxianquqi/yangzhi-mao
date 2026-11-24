import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeFileSha256, parseArgs, usage } from '../scripts/package-portable.mjs';
import { smokeTestPortable } from '../scripts/smoke-portable.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/package-portable.mjs', import.meta.url));

test('package-portable: parseArgs 正常解析并拒绝非法参数与缺失必填项', () => {
    const parsed = parseArgs(['--runtime', './runtime', '--out', './dist']);
    assert.equal(parsed.get('--runtime'), './runtime');
    assert.equal(parsed.get('--out'), './dist');
    assert.equal(parsed.get('--platform'), undefined);

    const full = parseArgs(['--runtime', './runtime', '--out', './dist', '--platform', 'win32', '--arch', 'x64']);
    assert.equal(full.get('--platform'), 'win32');
    assert.equal(full.get('--arch'), 'x64');

    assert.throws(() => parseArgs(['--out', './dist']), { message: usage });
    assert.throws(() => parseArgs(['--runtime', './runtime']), { message: usage });
    assert.throws(() => parseArgs(['--runtime']), { message: usage });
    assert.throws(() => parseArgs(['--unknown', 'val']), { message: usage });
    assert.throws(() => parseArgs(['--runtime', '--out']), { message: usage });
});

test('package-portable: computeFileSha256 正确计算文件哈希', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'write-sha-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = join(dir, 'test.bin');
    const content = Buffer.from('Write 便携版校验和测试数据 ' + Date.now());
    await writeFile(filePath, content);

    const expectedHash = createHash('sha256').update(content).digest('hex');
    const actualHash = await computeFileSha256(filePath);
    assert.equal(actualHash, expectedHash);
});

test('package-portable: CLI --help 输出使用说明', async () => {
    const output = await new Promise((resolve, reject) => {
        execFile(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
    assert.equal(output, usage);
});

test('package-portable: 使用当前 Node 生成便携包与 .sha256 校验和文件', async t => {
    const tempDir = await mkdtemp(join(tmpdir(), 'write-pkg-test-'));
    t.after(() => rm(tempDir, { recursive: true, force: true }));

    const mockRuntime = join(tempDir, 'mock-runtime');
    const outDir = join(tempDir, 'out');
    await mkdir(mockRuntime);
    await mkdir(outDir);

    const binName = process.platform === 'win32' ? 'node.exe' : 'node';
    const runtimeBinDir = process.platform === 'win32' ? mockRuntime : join(mockRuntime, 'bin');
    await mkdir(runtimeBinDir, { recursive: true });
    await copyFile(process.execPath, join(runtimeBinDir, binName));
    await writeFile(join(mockRuntime, 'LICENSE'), 'Node.js License Fixture\n');

    await new Promise((resolve, reject) => {
        execFile(process.execPath, [
            scriptPath,
            '--runtime', mockRuntime,
            '--out', outDir,
            '--platform', process.platform,
            '--arch', process.arch,
        ], { encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err) reject(new Error('打包执行失败: ' + err.message + '\n' + stderr + '\n' + stdout));
            else resolve(stdout);
        });
    });

    const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
    const archiveName = 'Write-0.1.0-' + process.platform + '-' + process.arch + ext;
    const archivePath = join(outDir, archiveName);
    const checksumPath = archivePath + '.sha256';

    const fileDigest = await computeFileSha256(archivePath);
    const checksumContent = await readFile(checksumPath, 'utf8');
    assert.equal(checksumContent, `${fileDigest}  ${archiveName}\n`);

    // 运行便携包产物冒烟测试验证可正常启动并响应 /api/health
    await smokeTestPortable(archivePath);

    // 验证产物已存在时不会静默覆盖
    await assert.rejects(async () => {
        await new Promise((resolve, reject) => {
            execFile(process.execPath, [
                scriptPath,
                '--runtime', mockRuntime,
                '--out', outDir,
                '--platform', process.platform,
                '--arch', process.arch,
            ], { encoding: 'utf8' }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || stdout));
                else resolve(stdout);
            });
        });
    }, /产物已存在/);
});
