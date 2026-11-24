// Opt-in CLI Agent registration. Unload cancels any turn still using this adapter.
// CLI settings only affect a spawned shell-free Antigravity process, not its global policy.
import { extname, isAbsolute } from 'node:path';
import { createAgyAdapter, DEFAULT_AGY_TIMEOUT_MS } from './agy.js';

const minimumTimeoutMs = 1000;
const maximumTimeoutMs = 600_000;

/** @typedef {import('../../src/kernel.js').PluginContext} PluginContext */

/**
 * @param {PluginContext} ctx
 * @param {unknown} config
 * @returns {void}
 */
export function apply(ctx, config) {
    if (!isObject(config)) throw new Error('Antigravity 插件配置必须是对象。');
    const bin = executable(config.bin ?? process.env.AGY_BIN?.trim());
    const timeoutMs = timeout(config.timeoutMs ?? (process.env.AGY_TIMEOUT_MS?.trim() || undefined));
    const lifetime = new AbortController();
    ctx.onDispose(() => lifetime.abort());
    ctx.provide('agent', { id: 'agy', run: createAgyAdapter({ bin, timeoutMs, signal: lifetime.signal }) });
}

/** @param {unknown} bin @returns {string|undefined} */
function executable(bin) {
    if (bin === undefined || bin === '') return undefined;
    if (typeof bin !== 'string' || !isAbsolute(bin) || (process.platform === 'win32' && extname(bin).toLowerCase() !== '.exe')) {
        throw new Error('AGY_BIN 或 bin 必须是可执行文件的绝对路径（Windows 下使用 .exe）。');
    }
    return bin;
}

/** @param {unknown} value @returns {number} */
function timeout(value) {
    if (value === undefined) return DEFAULT_AGY_TIMEOUT_MS;
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < minimumTimeoutMs || parsed > maximumTimeoutMs) {
        throw new Error('AGY_TIMEOUT_MS 或 timeoutMs 必须是 1000–600000 的整数。');
    }
    return parsed;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
