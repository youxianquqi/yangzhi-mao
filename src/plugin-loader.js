// Only the on-disk allowlist can enable code. The web UI can change settings for
// fixed, shipped IDs and disable existing entries; it never adds custom paths.
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCharacterLock } from './character-lock.js';
import { AppError, appError } from './errors.js';
import { bounded, diagnose, isPluginId, parsePluginManifest, verifiedPluginFile } from './kernel.js';
import { atomicJson } from './private-json.js';

const allowlistName = 'plugins.json';
const manifestName = 'plugin.json';
const maximumBytes = 64 * 1024;
const loadTimeoutMs = 10_000;
const maxEntries = 32;
const builtins = ['story-clues', 'persona-guard', 'card-importer', 'agent-openai-compat', 'agent-antigravity'];
const settingsId = '00000000-0000-0000-0000-000000000001';

/** @typedef {import('./kernel.js').Kernel} Kernel */
/** @typedef {import('./kernel.js').PluginLog} PluginLog */
/** @typedef {import('./kernel.js').PluginManifest} PluginManifest */
/** @typedef {{dataDir:string,pluginsDir:string,log?:PluginLog,safeMode?:boolean}} PluginOptions */
/** @typedef {Record<string,unknown> & {plugins:Record<string,unknown>}} Allowlist */
/** @typedef {'active'|'disabled'|'safe-mode'|'failed'} PluginState */
/** @typedef {{id:string,name:string,version:string|null,enabled:boolean,active:boolean,toggleable:boolean,builtIn:boolean,state:PluginState,overrides:NonNullable<PluginManifest['overrides']>,hides:NonNullable<PluginManifest['hides']>}} PluginSetting */

/**
 * Reads status without evaluating any entry module. Settings writes publish the
 * allowlist before changing this runtime; another running instance is unaffected.
 * @param {Kernel} kernel @param {PluginOptions} options
 */
export function createPluginManager(kernel, { dataDir, pluginsDir, log = () => {}, safeMode = process.env.SAFE_MODE === '1' }) {
    async function load() {
        if (safeMode) return;
        let data;
        try { data = await readAllowlist(dataDir); }
        catch {
            diagnose(log, 'allowlist', 'INVALID_ALLOWLIST');
            return;
        }
        const enabled = Object.entries(data.plugins).flatMap(([id, settings]) => {
            if (!isEnabled(settings)) return [];
            if (!isPluginId(id) || (settings.config !== undefined && !isObject(settings.config))) {
                diagnose(log, 'allowlist', 'INVALID_PLUGIN_SETTING', isPluginId(id) ? id : undefined);
                return [];
            }
            return [{ id, settings }];
        });
        for (const { id, settings } of enabled) await loadPlugin(id, settings);
    }

    /** @returns {Promise<PluginSetting[]>} */
    async function list() {
        const data = await readAllowlist(dataDir).catch(() => ({ plugins: {} }));
        const ids = new Set([...builtins, ...Object.keys(data.plugins).filter(isPluginId)]);
        const rows = await Promise.all([...ids].map(async id => {
            const { manifest } = await getManifest(pluginsDir, id).catch(() => ({ manifest: undefined }));
            if (!manifest && !Object.hasOwn(data.plugins, id)) return undefined;
            return setting(id, data.plugins[id], manifest);
        }));
        return rows.filter(row => row !== undefined);
    }

    /** @param {string} id @param {boolean} enabled @returns {Promise<PluginSetting>} */
    async function setEnabled(id, enabled) {
        if (!isPluginId(id) || (enabled === true && !builtins.includes(id))) throw appError('ROUTE_NOT_FOUND');
        if (typeof enabled !== 'boolean') throw appError('INVALID_INPUT');
        const lock = await createCharacterLock(dataDir);
        const release = await lock.acquire(settingsId);
        try {
            const data = await readAllowlist(dataDir);
            const current = data.plugins[id];
            if (!builtins.includes(id) && !isEnabled(current)) throw appError('ROUTE_NOT_FOUND');
            const { manifest } = await getManifest(pluginsDir, id).catch(() => ({ manifest: undefined }));
            if (!manifest && (!Object.hasOwn(data.plugins, id) || enabled)) throw appError('ROUTE_NOT_FOUND');
            if (!Object.hasOwn(data.plugins, id) && Object.keys(data.plugins).length >= maxEntries) {
                throw appError('INVALID_INPUT', { message: '插件白名单已达到条目上限。' });
            }
            const next = { ...(isObject(current) ? current : {}), enabled };
            // Re-enabling wins the same conflicts after restart as it does during this session.
            if (enabled && !kernel.isActive(id)) delete data.plugins[id];
            data.plugins[id] = next;
            const pretty = JSON.stringify(data, null, 2) + '\n';
            const text = Buffer.byteLength(pretty) <= maximumBytes ? pretty : JSON.stringify(data);
            if (Buffer.byteLength(text) > maximumBytes) throw appError('PAYLOAD_TOO_LARGE');
            await atomicJson(join(await realpath(dataDir), allowlistName), text);
            if (!enabled) await kernel.unregister(id);
            else if (!safeMode && !kernel.isActive(id)) await loadPlugin(id, next);
            return setting(id, next, manifest);
        } catch (cause) {
            if (cause instanceof AppError) throw cause;
            throw appError('STORAGE_ERROR', { cause });
        } finally {
            await release();
        }
    }

    /** @param {string} id @param {unknown} settings @param {PluginManifest} [manifest] @returns {PluginSetting} */
    function setting(id, settings, manifest) {
        const enabled = isEnabled(settings);
        const active = kernel.isActive(id);
        return {
            id, name: manifest?.name ?? id, version: manifest?.version ?? null,
            enabled, active, toggleable: builtins.includes(id) || enabled, builtIn: builtins.includes(id),
            overrides: manifest?.overrides ?? [], hides: manifest?.hides ?? [],
            state: active ? 'active' : !enabled ? 'disabled' : safeMode ? 'safe-mode' : 'failed',
        };
    }

    /** @param {string} id @param {Record<string,unknown>} settings */
    async function loadPlugin(id, settings) {
        try {
            if (settings.config !== undefined && !isObject(settings.config)) throw new Error('Invalid plugin config');
            const config = isObject(settings.config) ? settings.config : {};
            const { directory, manifest } = await getManifest(pluginsDir, id);
            const entry = pathToFileURL(await verifiedPluginFile(directory, manifest.entry)).href;
            const module = await bounded(() => import(entry), [], loadTimeoutMs);
            if (typeof module.apply !== 'function') throw new Error('Missing apply function');
            await kernel.register(manifest, module.apply, config, directory);
        } catch {
            diagnose(log, 'load', 'PLUGIN_LOAD_FAILED', id);
        }
    }

    return { safeMode, load, list, setEnabled };
}

/** @param {Kernel} kernel @param {PluginOptions} options @returns {Promise<void>} */
export async function loadEnabledPlugins(kernel, options) {
    await createPluginManager(kernel, options).load();
}

/** @param {string} dataDir @returns {Promise<Allowlist>} */
async function readAllowlist(dataDir) {
    try {
        const realDataDir = await realpath(dataDir);
        const data = await readJson(await verifiedPluginFile(realDataDir, allowlistName));
        if (!isObject(data) || !isObject(data.plugins)) throw new Error('Missing plugins object');
        if (Object.keys(data.plugins).length > maxEntries) throw new Error('Too many plugin settings');
        return { ...data, plugins: data.plugins };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { plugins: {} };
        throw error;
    }
}

/** @param {string} root @param {string} id */
async function getManifest(root, id) {
    const directory = await pluginDirectory(root, id);
    const manifest = parsePluginManifest(await readJson(await verifiedPluginFile(directory, manifestName)));
    if (!manifest || manifest.id !== id) throw new Error('Manifest mismatch');
    return { directory, manifest };
}

/** @param {string} root @param {string} id @returns {Promise<string>} */
async function pluginDirectory(root, id) {
    const canonicalRoot = await realpath(root);
    const directory = join(canonicalRoot, id);
    const metadata = await lstat(directory);
    const canonical = await realpath(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(canonicalRoot, dirname(canonical))
        || relative(directory, canonical)) throw new Error('Plugin directory rejected');
    return canonical;
}

/** @param {string} path @returns {Promise<unknown>} */
async function readJson(path) {
    const file = await open(path, 'r');
    try {
        const content = Buffer.alloc(maximumBytes + 1);
        let offset = 0;
        while (offset < content.length) {
            const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset > maximumBytes) throw new RangeError('Plugin JSON file exceeds limit');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, offset)));
    } finally {
        await file.close();
    }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Record<string,unknown> & {enabled:true}} */
function isEnabled(value) {
    return isObject(value) && value.enabled === true;
}
