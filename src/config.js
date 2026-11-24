// Owns runtime defaults and shared limits so HTTP, storage and Agent checks agree.
// No filesystem or network side effects; configuration values are startup input.
import { extname, isAbsolute, resolve } from 'node:path';

export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
// Legacy records without a provider belong to the original Codex adapter.
export const DEFAULT_PROVIDER = 'codex';

export const LOOPBACK_HOST = '127.0.0.1';
export const JSON_BODY_LIMIT = '64kb';
export const LIMITS = Object.freeze({
    nameLength: 50, descriptionLength: 4000, greetingLength: 1000,
    threadNameLength: 80, threadsPerCharacter: 24, messagePageSize: 60, messagePageMax: 100,
    messageLength: 8000, replyLength: 32_000, sessionIdLength: 256, historyMessages: 200, historyShardMessages: 64, turnMessages: 2,
    codexOutputBytes: 4 * 1024 * 1024,
});

const PORT_RANGE = { fallback: 3210, min: 1, max: 65_535 };
const TIMEOUT_RANGE = { fallback: DEFAULT_CODEX_TIMEOUT_MS, min: 1000, max: 600_000 };

/** @typedef {{port: number, dataDir: string, useCodex: boolean, codexTimeoutMs: number, codexBin: string | undefined}} RuntimeConfig */

/**
 * @param {string} root Project directory; relative DATA_DIR values resolve here.
 * @param {NodeJS.ProcessEnv} [env] Startup environment.
 * @returns {RuntimeConfig} Validated configuration or a startup error for invalid values.
 */
export function readConfig(root, env = process.env) {
    const useCodex = env.WRITE_AGENT === 'codex';
    return {
        port: integerSetting(env, 'PORT', PORT_RANGE),
        dataDir: resolve(root, env.DATA_DIR?.trim() || 'data'),
        useCodex,
        codexTimeoutMs: useCodex ? integerSetting(env, 'CODEX_TIMEOUT_MS', TIMEOUT_RANGE) : DEFAULT_CODEX_TIMEOUT_MS,
        codexBin: useCodex ? executableSetting(env, 'CODEX_BIN') : undefined,
    };
}

function executableSetting(env, key) {
    const bin = env[key]?.trim() || undefined;
    if (bin && (!isAbsolute(bin) || (process.platform === 'win32' && extname(bin).toLowerCase() !== '.exe'))) {
        throw new Error(key + ' 必须是可执行文件的绝对路径（Windows 下使用 .exe）。');
    }
    return bin;
}

function integerSetting(env, key, { fallback, min, max }) {
    const value = env[key];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(key + ' 必须是 ' + min + '–' + max + ' 之间的整数。');
    }
    return parsed;
}
