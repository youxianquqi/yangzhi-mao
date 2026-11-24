// Same-origin plugin modules are executable opt-in code; Shadow DOM isolates styles only.

/** @typedef {'character-sidebar'|'thread-selector'|'main-view'} DefaultSlot */
/** @typedef {DefaultSlot|'sidebar'|'message-actions'|'toolbar'} Slot */
/** @typedef {{pluginId: string, slot: Slot, tag: string, entry: string, style?: string}} Descriptor */
/** @typedef {{pluginId: string, slot: DefaultSlot, action: 'override'|'hide'}} Claim */
/** @typedef {Readonly<import('./state.js').Message & {index: number}>} MessageActionInput */
/** @typedef {HTMLElement & {message?: MessageActionInput}} PluginElement */

const defaultSlots = new Set(['character-sidebar', 'thread-selector', 'main-view']);
const slots = new Set(['toolbar', 'sidebar', 'message-actions', ...defaultSlots]);
const characterIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const tagPattern = /^[a-z][a-z0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const scriptPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.m?js$/;
const stylePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.css$/;

/**
 * A newer discovery invalidates older asynchronous imports, including a module
 * still loading when its plugin is disabled.
 * @param {() => Promise<{registry:unknown,claims:unknown}>} read
 * @param {(item: Descriptor) => Promise<boolean>} load
 */
export function createExtensionRegistry(read, load) {
    /** @type {Map<string, Descriptor>} */
    let ready = new Map();
    /** @type {Map<DefaultSlot, Claim>} */
    let effects = new Map();
    let generation = 0;

    /** @param {() => void} onChange */
    async function discover(onChange) {
        const requested = ++generation;
        const result = await read().catch(() => ({ registry: [], claims: [] }));
        if (requested !== generation) return;
        const registry = Array.isArray(result.registry) ? result.registry.filter(isDescriptor) : [];
        const claims = Array.isArray(result.claims) ? result.claims.filter(isClaim) : [];
        effects = new Map(claims.map(claim => [claim.slot, claim]));
        const previous = ready;
        ready = new Map();
        const pending = registry.filter(item => {
            const old = previous.get(item.tag);
            if (!old || item.entry !== old.entry || item.slot !== old.slot) return true;
            ready.set(item.tag, item);
            return false;
        });
        onChange();

        await Promise.all(pending.map(async item => {
            try {
                if (!await load(item) || requested !== generation) return;
                ready.set(item.tag, item);
                onChange();
            } catch {
                if (requested === generation) console.warn({ event: 'plugin_ui_load_failed', pluginId: item.pluginId });
            }
        }));
    }

    /** @param {Slot} slot */
    function items(slot) {
        return [...ready.values()].filter(item => item.slot === slot)
            .sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.tag.localeCompare(b.tag));
    }

    /** @param {DefaultSlot} slot */
    function effect(slot) {
        const claim = effects.get(slot);
        if (claim?.action === 'hide') return { hidden: true, replacement: undefined };
        if (claim?.action === 'override') {
            const replacement = items(slot).find(item => item.pluginId === claim.pluginId);
            if (replacement) return { hidden: true, replacement };
        }
        return { hidden: false, replacement: undefined };
    }

    return { discover, items, effect };
}

const extensions = createExtensionRegistry(async () => {
    const [registry, claims] = await Promise.all([
        readRegistry('/api/plugins/ui'),
        readRegistry('/api/plugins/ui/defaults'),
    ]);
    return { registry, claims };
}, async item => {
    await import(item.entry);
    return Boolean(customElements.get(item.tag));
});

/** @param {string} path @returns {Promise<unknown>} */
async function readRegistry(path) {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    return response.ok ? response.json() : [];
}

export const discoverExtensions = extensions.discover;

/** @param {Slot} name @returns {boolean} */
export function hasExtensions(name) {
    return extensions.items(name).length > 0;
}

/**
 * Keep the existing default DOM and its event listeners intact. On unregister
 * only the plugin mount is disconnected; the untouched default can reappear.
 * @param {DefaultSlot} name @param {HTMLElement} fallback @param {HTMLElement} target
 * @param {string|null} characterId @param {string|null} threadId
 * @param {ReturnType<typeof createExtensionRegistry>} [registry]
 */
export function updateDefaultModule(name, fallback, target, characterId, threadId, registry = extensions) {
    const { hidden, replacement } = registry.effect(name);
    const mount = updateMounts(target, replacement ? [replacement] : [], characterId, threadId);
    fallback.hidden = hidden && (!replacement || Boolean(mount));
    target.hidden = !mount;
}

/** @param {HTMLElement} target @param {string|null} characterId @param {string|null} [threadId] */
export function updateSidebar(target, characterId, threadId = null) {
    updateMounts(target, characterId ? extensions.items('sidebar') : [], characterId, threadId);
}

/**
 * Global tools remain available even before the first character exists.
 * @param {HTMLElement} target @param {string|null} characterId @param {string|null} threadId
 * @param {ReturnType<typeof createExtensionRegistry>} [registry]
 */
export function updateToolbar(target, characterId, threadId, registry = extensions) {
    target.hidden = !updateMounts(target, registry.items('toolbar'), characterId, threadId);
}

/**
 * Receives only an ID, not a plugin-supplied character. The shell reloads the
 * authoritative roster before selecting it.
 * @param {HTMLElement} target @param {(id:string) => void} onCreated
 */
export function bindToolbarCharacterCreated(target, onCreated) {
    target.addEventListener('write-character-created', event => {
        if (!(event instanceof CustomEvent) || !event.bubbles || !event.composed
            || typeof event.detail !== 'string' || event.detail.length !== 36 || !characterIdPattern.test(event.detail)) return;
        const path = event.composedPath();
        if ([...target.children].some(mount => path.includes(mount))) onCreated(event.detail.toLowerCase());
    }, { capture: true });
}

/** @param {HTMLElement} target @param {Descriptor[]} items @param {string|null} characterId @param {string|null} threadId */
function updateMounts(target, items, characterId, threadId) {
    const tags = new Set(items.map(item => item.tag));
    for (const node of [...target.children]) {
        if (!tags.has(/** @type {HTMLElement} */ (node).dataset.tag ?? '')) node.remove();
    }
    for (const item of items) {
        const existing = [...target.children].find(node => /** @type {HTMLElement} */ (node).dataset.tag === item.tag);
        if (existing?.shadowRoot?.firstElementChild) {
            setContext(existing.shadowRoot.firstElementChild, characterId, threadId);
        } else {
            const mount = mountExtension(item, characterId, threadId);
            if (mount) target.append(mount);
        }
    }
    return target.firstElementChild;
}

/** @param {HTMLElement} container @param {string} characterId @param {MessageActionInput} message @param {string|null} [threadId] */
export function updateMessageActions(container, characterId, message, threadId = null) {
    container.replaceChildren();
    for (const item of extensions.items('message-actions')) {
        const mount = mountExtension(item, characterId, threadId, message);
        if (mount) container.append(mount);
    }
}

/** @param {Descriptor} item @param {string|null} characterId @param {string|null} threadId @param {MessageActionInput} [message] */
function mountExtension(item, characterId, threadId, message) {
    try {
        if (!customElements.get('write-plugin-mount')) {
            customElements.define('write-plugin-mount', class extends HTMLElement {});
        }
        const host = document.createElement('write-plugin-mount');
        const root = host.attachShadow({ mode: 'open' });
        const component = /** @type {PluginElement} */ (document.createElement(item.tag));
        const constructor = customElements.get(item.tag);
        if (!constructor || !(component instanceof constructor)) throw new Error('Component initialisation failed');
        host.dataset.tag = item.tag;
        if (message) component.message = Object.freeze({ ...message });
        setContext(component, characterId, threadId);
        root.append(component);
        return host;
    } catch {
        console.warn({ event: 'plugin_ui_mount_failed', pluginId: item.pluginId });
        return undefined;
    }
}

/** @param {Element} component @param {string|null} characterId @param {string|null} threadId */
function setContext(component, characterId, threadId) {
    setAttribute(component, 'character-id', characterId);
    setAttribute(component, 'thread-id', threadId);
}

/** @param {Element} component @param {string} key @param {string|null} value */
function setAttribute(component, key, value) {
    if (component.getAttribute(key) === value) return;
    if (value === null) component.removeAttribute(key);
    else component.setAttribute(key, value);
}

/** @param {unknown} value @returns {value is Claim} */
function isClaim(value) {
    const item = /** @type {Partial<Claim>|null} */ (value);
    return Boolean(item && typeof item.pluginId === 'string' && idPattern.test(item.pluginId)
        && item.slot && defaultSlots.has(item.slot)
        && (item.action === 'hide' || item.action === 'override'));
}

/** @param {unknown} value @returns {value is Descriptor} */
function isDescriptor(value) {
    const item = /** @type {Partial<Descriptor>|null} */ (value);
    if (!item || typeof item.pluginId !== 'string' || !idPattern.test(item.pluginId)
        || typeof item.tag !== 'string' || !tagPattern.test(item.tag) || item.tag.startsWith('write-')
        || !item.tag.startsWith(item.pluginId + '-')
        || (!item.slot || !slots.has(item.slot))) return false;
    const prefix = '/plugin-assets/' + item.pluginId + '/';
    return ownAsset(item.entry, prefix, scriptPattern)
        && (item.style === undefined || ownAsset(item.style, prefix, stylePattern));
}

/** @param {unknown} value @param {string} prefix @param {RegExp} filename */
function ownAsset(value, prefix, filename) {
    return typeof value === 'string' && value.startsWith(prefix) && filename.test(value.slice(prefix.length));
}
