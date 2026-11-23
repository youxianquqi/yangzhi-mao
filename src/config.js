import { extname, isAbsolute, resolve } from 'node:path';

function integerSetting(env, key, fallback, min, max) {
    const value = env[key];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(key + ' 必须是 ' + min + '–' + max + ' 之间的整数。');
    }
    return parsed;
}

export function readConfig(root, env = process.env) {
    const codexBin = env.CODEX_BIN?.trim() || undefined;
    if (codexBin && (!isAbsolute(codexBin) || (process.platform === 'win32' && extname(codexBin).toLowerCase() !== '.exe'))) {
        throw new Error('CODEX_BIN 必须是 Codex 可执行文件的绝对路径（Windows 下使用 .exe）。');
    }
    return {
        port: integerSetting(env, 'PORT', 3210, 1, 65535),
        dataDir: resolve(root, env.DATA_DIR?.trim() || 'data'),
        codexTimeoutMs: integerSetting(env, 'CODEX_TIMEOUT_MS', 120_000, 1000, 600_000),
        codexBin,
    };
}
