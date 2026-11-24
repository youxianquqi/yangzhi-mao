// Reads only local, explicitly enabled plugins; never scans or imports other folders.
// Registrations remain inactive until the kernel accepts the manifest and apply result.
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bounded, diagnose, isPluginId, parsePluginManifest, verifiedPluginFile } from './kernel.js';

const allowlistName = 'plugins.json';
const manifestName = 'plugin.json';
const maximumBytes = 64 * 1024;
const loadTimeoutMs = 10_000;
const maxEntries = 32;

/** @typedef {ReturnType<typeof import('./kernel.js').createKernel>} Kernel */
/** @typedef {import('./kernel.js').PluginLog} PluginLog */
/** @typedef {{id:string,config:Record<string,unknown>}} EnabledPlugin */

/**
 * @param {Kernel} kernel
 * @param {{dataDir:string,pluginsDir:string,log?:PluginLog}} options
 * @returns {Promise<void>} Invalid or missing configuration never disables defaults.
 */
export async function loadEnabledPlugins(kernel, { dataDir, pluginsDir, log = () => {} }) {
    const enabled = await getEnabled(dataDir, log);
    if (!enabled.length) return;
    for (const plugin of enabled) {
        try {
            const directory = await pluginDirectory(pluginsDir, plugin.id);
            const manifest = parsePluginManifest(await readJson(await verifiedPluginFile(directory, manifestName)));
            if (!manifest || manifest.id !== plugin.id) throw new Error('Manifest mismatch');
            const entry = pathToFileURL(await verifiedPluginFile(directory, manifest.entry)).href;
            const module = await bounded(() => import(entry), [], loadTimeoutMs);
            if (typeof module.apply !== 'function') throw new Error('Missing apply function');
            await kernel.register(manifest, module.apply, plugin.config, directory);
        } catch {
            diagnose(log, 'load', 'PLUGIN_LOAD_FAILED', plugin.id);
        }
    }
}

/** @param {string} dataDir @param {PluginLog} log @returns {Promise<EnabledPlugin[]>} */
async function getEnabled(dataDir, log) {
    try {
        const realDataDir = await realpath(dataDir);
        const path = await verifiedPluginFile(realDataDir, allowlistName);
        const data = await readJson(path);
        if (!isObject(data) || !isObject(data.plugins)) throw new Error('Missing plugins object');
        const entries = Object.entries(data.plugins);
        if (entries.length > maxEntries) throw new Error('Too many enabled entries');
        return entries.flatMap(([id, settings]) => {
            if (!isObject(settings) || settings.enabled !== true) return [];
            if (!isPluginId(id) || (settings.config !== undefined && !isObject(settings.config))) {
                diagnose(log, 'allowlist', 'INVALID_PLUGIN_SETTING', isPluginId(id) ? id : undefined);
                return [];
            }
            return [{ id, config: isObject(settings.config) ? settings.config : {} }];
        });
    } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) diagnose(log, 'allowlist', 'INVALID_ALLOWLIST');
        return [];
    }
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
