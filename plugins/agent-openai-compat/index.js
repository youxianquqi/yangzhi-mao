// Opt-in HTTP Agent for user-selected endpoints, distinct from the official presets.
import {
    createOpenAIService, normalizeOpenAIBaseUrl, normalizeOpenAIModel, normalizeOpenAIToken, OPENAI_TIMEOUT_MS,
} from '../../src/agents/openai-compat.js';

/** @typedef {import('../../src/kernel.js').PluginContext} PluginContext */

/** @param {PluginContext} ctx @param {unknown} config */
export function apply(ctx, config) {
    if (!isObject(config)) throw new Error('配置须指定 baseUrl 与 model。');
    const { baseUrl, model, apiKeyEnv, timeoutMs = OPENAI_TIMEOUT_MS } = config;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
        throw new Error('timeoutMs 必须是 1000–600000 的整数。');
    }
    const lifetime = new AbortController();
    const agent = createOpenAIService('agent-openai-compat', {
        baseUrl: normalizeOpenAIBaseUrl(baseUrl), model: normalizeOpenAIModel(model),
        token: optionalToken(apiKeyEnv), timeoutMs, lifetime: lifetime.signal,
    });
    ctx.onDispose(() => lifetime.abort());
    ctx.provide('agent', agent);
}

/** @param {unknown} envName @returns {string|undefined} */
function optionalToken(envName) {
    if (envName === undefined) return undefined;
    if (typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName)) {
        throw new Error('apiKeyEnv 必须是环境变量名。');
    }
    const value = normalizeOpenAIToken(process.env[envName]);
    if (!value) throw new Error('模型密钥环境变量缺失或格式无效。');
    return value;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
