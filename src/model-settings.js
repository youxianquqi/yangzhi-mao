// The public settings view never carries a stored or environment credential.
import { join } from 'node:path';
import { createCharacterLock } from './character-lock.js';
import { AppError, appError } from './errors.js';
import { atomicJson, privateDirectory, readJson } from './private-json.js';
import {
    createOpenAIService, isLoopbackUrl, normalizeOpenAIBaseUrl, normalizeOpenAIModel,
    normalizeOpenAIToken, probeOpenAIConnection,
} from './agents/openai-compat.js';

/** @typedef {'deepseek'|'minimax'} PresetId */
/** @typedef {{id:PresetId,name:string,baseUrl:string,model:string}} Preset */
/** @typedef {{preset:PresetId,baseUrl:string,model:string,apiKey?:string}} ModelSelection */
/** @typedef {import('./agents/adapter.js').AgentService} AgentService */

const presets = /** @type {readonly Preset[]} */ (Object.freeze([
    Object.freeze({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }),
    Object.freeze({ id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash' }),
]));
const providerOrigins = {
    deepseek: new Set(['https://api.deepseek.com']),
    minimax: new Set(['https://api.minimax.cn', 'https://api.minimax.io', 'https://api.minimaxi.com']),
};
const keyVariable = { deepseek: 'DEEPSEEK_API_KEY', minimax: 'MINIMAX_API_KEY' };
const maxFileBytes = 64 * 1024;
// Reserved non-v4 identifier; cannot collide with a generated role or thread ID.
const settingsLock = '00000000-0000-0000-0000-000000000002';

/** @param {string} dataDir @param {{env?:NodeJS.ProcessEnv,fetcher?:typeof fetch}} [dependencies] */
export async function createModelSettings(dataDir, { env = process.env, fetcher } = {}) {
    await privateDirectory(dataDir);
    const file = join(dataDir, 'secrets.json');
    const lock = await createCharacterLock(dataDir);
    const tokens = {
        deepseek: normalizeOpenAIToken(env[keyVariable.deepseek]),
        minimax: normalizeOpenAIToken(env[keyVariable.minimax]),
    };
    const initial = presets[!tokens.deepseek && tokens.minimax ? 1 : 0];
    const fallback = { preset: initial.id, baseUrl: initial.baseUrl, model: initial.model };

    async function readSelection() {
        try {
            const saved = await readJson(file, maxFileBytes);
            return saved === undefined ? fallback : readForm(saved);
        } catch (cause) {
            throw appError('STORAGE_ERROR', { cause, message: '无法读取模型设置，请检查数据目录中的 secrets.json。' });
        }
    }

    /** @param {ModelSelection} next */
    function resolveSelection(next) {
        const url = new URL(next.baseUrl);
        const official = providerOrigins[next.preset].has(url.origin);
        const fromEnvironment = official ? tokens[next.preset] : undefined;
        const token = fromEnvironment ?? next.apiKey;
        const options = official && next.preset === 'deepseek'
            && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(next.model)
            ? { thinking: { type: 'disabled' } }
            : official && next.preset === 'minimax' && ['MiniMax-M3.1-Flash', 'MiniMax-M3'].includes(next.model)
                ? { reasoning_split: true } : undefined;
        const configured = Boolean(token) || isLoopbackUrl(url);
        return {
            settings: { baseUrl: next.baseUrl, model: next.model, token, options, configured, fetcher },
            source: /** @type {'environment'|'saved'|null} */ (fromEnvironment ? 'environment' : token ? 'saved' : null),
        };
    }

    let current = await readSelection();
    let effective = resolveSelection(current);
    let agent = createOpenAIService(current.preset, effective.settings);

    function describe() {
        const { token, configured, baseUrl, model } = effective.settings;
        return {
            preset: current.preset, baseUrl, model, configured,
            apiKeyConfigured: Boolean(token),
            // A very short test key must not be returned in its entirety.
            apiKeyLast4: token?.length > 4 ? token.slice(-4) : null,
            apiKeySource: effective.source,
            presets,
        };
    }

    return {
        describe,
        /** @returns {AgentService} Effective adapter pinned to the configuration at acquisition. */
        getAgent: () => agent,
        /** @param {unknown} body @param {AbortSignal} [signal] */
        async save(body, signal) {
            const release = await lock.acquire(settingsLock);
            try {
                const currentOnDisk = await readSelection();
                const next = readForm(body, currentOnDisk);
                const nextEffective = resolveSelection(next);
                await atomicJson(file, JSON.stringify(next, null, 2) + '\n', signal);
                if (current.preset !== next.preset || effective.settings.baseUrl !== nextEffective.settings.baseUrl
                    || effective.settings.model !== nextEffective.settings.model || effective.settings.token !== nextEffective.settings.token) {
                    agent = createOpenAIService(next.preset, nextEffective.settings);
                }
                current = next;
                effective = nextEffective;
                return describe();
            } finally {
                await release();
            }
        },
        /** @param {unknown} body @param {AbortSignal} [signal] */
        async testConnection(body, signal) {
            const next = isObject(body) && Object.keys(body).length === 0 ? current : readForm(body, current);
            const url = new URL(next.baseUrl);
            if (!isLoopbackUrl(url) && !providerOrigins[next.preset].has(url.origin)) {
                throw appError('INVALID_INPUT', { message: '测试连接仅支持所选预设的官方 API 或本机回环地址。' });
            }
            const { settings } = resolveSelection(next);
            if (!settings.configured) throw appError('INVALID_INPUT', { message: '请先填写 API Key。' });
            return probeOpenAIConnection(settings, signal);
        },
    };
}

/** @param {unknown} body @param {ModelSelection} [previous] @returns {ModelSelection} */
function readForm(body, previous) {
    if (!isObject(body) || Object.keys(body).some(key => !['preset', 'baseUrl', 'model', 'apiKey'].includes(key))) {
        throw appError('INVALID_INPUT', { message: '模型设置字段无效。' });
    }
    const preset = presets.find(item => item.id === body.preset);
    if (!preset) throw appError('INVALID_INPUT', { message: '请选择 DeepSeek 或 MiniMax。' });
    try {
        const baseUrl = normalizeOpenAIBaseUrl(body.baseUrl === undefined ? preset.baseUrl : body.baseUrl);
        const model = normalizeOpenAIModel(body.model === undefined ? preset.model : body.model);
        /** @type {string|undefined} */
        let apiKey;
        if (body.apiKey === undefined || body.apiKey === '') {
            // Never silently forward a saved secret to a different endpoint or provider.
            if (previous?.preset === preset.id && previous.baseUrl === baseUrl) apiKey = previous.apiKey;
        } else if (body.apiKey !== null) {
            apiKey = normalizeOpenAIToken(body.apiKey);
            if (!apiKey) throw new Error('API Key 格式无效。');
        }
        // The settings and credential binding commit as one file.
        return { preset: preset.id, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
    } catch (cause) {
        throw cause instanceof AppError ? cause : appError('INVALID_INPUT', {
            message: cause instanceof Error ? cause.message : '模型设置无效。',
        });
    }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
