// Mirrors the server's enabled UI slots. Each mount has a shadow root independent of other plugins.
// Plugin modules are opt-in, same-origin executable code; CSS isolation is not a security sandbox.

/** @typedef {'sidebar'|'message-actions'} Slot */
/** @typedef {{pluginId: string, slot: Slot, tag: string, entry: string, style?: string}} Descriptor */
/** @typedef {Readonly<import('./state.js').Message & {index: number}>} MessageActionInput */
/** @typedef {HTMLElement & {message?: MessageActionInput}} PluginElement */

/** @type {Record<Slot, Descriptor[]>} */
const active = { sidebar: [], 'message-actions': [] };
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const tagPattern = /^[a-z][a-z0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const scriptPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.m?js$/;
const stylePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.css$/;

if (!customElements.get('write-plugin-mount')) {
    customElements.define('write-plugin-mount', class extends HTMLElement {});
}

/** @param {() => void} onChange @returns {Promise<void>} One slow module cannot delay other mounts. */
export async function discoverExtensions(onChange) {
    const response = await fetch('/api/plugins/ui', { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return;
    const registry = await response.json();
    if (!Array.isArray(registry)) return;
    await Promise.all(registry.map(async item => {
        if (!isDescriptor(item)) return;
        try {
            await import(item.entry);
            if (!customElements.get(item.tag)) return;
            active[item.slot].push(item);
            active[item.slot].sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.tag.localeCompare(b.tag));
            onChange();
        } catch {
            console.warn({ event: 'plugin_ui_load_failed', pluginId: item.pluginId });
        }
    }));
}

/** @param {Slot} name @returns {boolean} */
export function hasExtensions(name) {
    return active[name].length > 0;
}

/** @param {HTMLElement} target @param {string|null} characterId @param {string|null} [threadId] @returns {void} */
export function updateSidebar(target, characterId, threadId = null) {
    for (const item of active.sidebar) {
        let mount = [...target.children].find(node => /** @type {HTMLElement} */ (node).dataset.tag === item.tag);
        if (!characterId) { mount?.remove(); continue; }
        if (!mount) {
            mount = mountExtension(item, characterId, threadId);
            if (mount) target.append(mount);
            continue;
        }
        const component = mount.shadowRoot?.firstElementChild;
        if (component?.getAttribute('character-id') !== characterId) component?.setAttribute('character-id', characterId);
        if (component) setThreadAttribute(component, threadId);
    }
}

/** @param {HTMLElement} container @param {string} characterId @param {MessageActionInput} message @param {string|null} [threadId] @returns {void} */
export function updateMessageActions(container, characterId, message, threadId = null) {
    container.replaceChildren();
    for (const item of active['message-actions']) {
        const mount = mountExtension(item, characterId, threadId, message);
        if (mount) container.append(mount);
    }
}

/** @param {Descriptor} item @param {string} characterId @param {string|null} threadId @param {MessageActionInput} [message] */
function mountExtension(item, characterId, threadId, message) {
    try {
        const host = document.createElement('write-plugin-mount');
        const root = host.attachShadow({ mode: 'open' });
        const component = /** @type {PluginElement} */ (document.createElement(item.tag));
        host.dataset.tag = item.tag;
        if (message) component.message = Object.freeze({ ...message });
        component.setAttribute('character-id', characterId);
        setThreadAttribute(component, threadId);
        root.append(component);
        return host;
    } catch {
        console.warn({ event: 'plugin_ui_mount_failed', pluginId: item.pluginId });
        return undefined;
    }
}

/** @param {Element} component @param {string|null} threadId */
function setThreadAttribute(component, threadId) {
    if (component.getAttribute('thread-id') === threadId) return;
    if (threadId === null) component.removeAttribute('thread-id');
    else component.setAttribute('thread-id', threadId);
}

/** @param {unknown} value @returns {value is Descriptor} */
function isDescriptor(value) {
    const item = /** @type {Partial<Descriptor>|null} */ (value);
    if (!item || typeof item.pluginId !== 'string' || !idPattern.test(item.pluginId)
        || typeof item.tag !== 'string' || !tagPattern.test(item.tag) || item.tag.startsWith('write-')
        || !item.tag.startsWith(item.pluginId + '-')
        || (item.slot !== 'sidebar' && item.slot !== 'message-actions')) return false;
    const prefix = '/plugin-assets/' + item.pluginId + '/';
    return ownAsset(item.entry, prefix, scriptPattern)
        && (item.style === undefined || ownAsset(item.style, prefix, stylePattern));
}

/** @param {unknown} value @param {string} prefix @param {RegExp} filename */
function ownAsset(value, prefix, filename) {
    return typeof value === 'string' && value.startsWith(prefix) && filename.test(value.slice(prefix.length));
}
