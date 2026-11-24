// Owns typed plugin effects; only successful scopes publish hooks, routes, UI and services.
// Disposing a scope unpublishes it before cancelling work or calling user cleanups.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { AppError, appError } from './errors.js';

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const assetPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.(?:m?js|css)$/;
const permissions = /** @type {const} */ (['storage', 'migrate', 'hooks', 'routes', 'ui', 'provide:agent', 'provide:storage']);
const serviceSlots = /** @type {const} */ (['agent', 'storage']);
const defaultUiSlots = /** @type {const} */ (['character-sidebar', 'thread-selector', 'main-view']);
const slots = /** @type {const} */ (['sidebar', 'message-actions', 'toolbar', ...defaultUiSlots]);
const overrideSlots = /** @type {const} */ ([...serviceSlots, ...defaultUiSlots]);

const methods = /** @type {const} */ (['GET', 'POST', 'PUT', 'DELETE']);
const events = /** @type {const} */ (['beforePrompt', 'onDelta', 'afterTurn', 'onSessionReset']);
const maxContextBytes = 64 * 1024;
const maxRouteBytes = 64 * 1024;
const maxScopes = 32;
const maxEffectsPerKind = 32;
const initializationTimeoutMs = 10_000;
const hookTimeoutMs = 2_000;
const routeTimeoutMs = 10_000;

/** @typedef {import('../types/json.js').JsonValue} JsonValue */
/** @typedef {ReturnType<typeof createKernel>} Kernel */
/** @typedef {import('./storage.js').StorageService} StorageService */
/** @typedef {import('./storage.js').NamespaceStore} NamespaceStore */
/** @typedef {import('./agents/adapter.js').AgentService} AgentService */
/** @typedef {{agent: AgentService, storage: StorageService}} Services */
/** @typedef {typeof permissions[number]} Permission */
/** @typedef {typeof slots[number]} SlotName */
/** @typedef {typeof defaultUiSlots[number]} DefaultUiSlot */
/** @typedef {typeof overrideSlots[number]} OverrideSlot */
/** @typedef {{slot:DefaultUiSlot,pluginId:string,action:'override'|'hide'}} DefaultUiClaim */
/** @typedef {typeof methods[number]} RouteMethod */
/** @typedef {{id:string,name:string,version:string,entry:string,slots:SlotName[],permissions:Permission[],overrides?:OverrideSlot[],hides?:DefaultUiSlot[]}} PluginManifest */
/** @typedef {{tag:string,entry:string,style?:string}} SlotDescriptor */
/** @typedef {SlotDescriptor & {pluginId:string,slot:SlotName}} PublicSlot */
/** @typedef {{event:'plugin_failed',phase:string,code:string,pluginId?:string} | {event:'plugin_conflict',phase:'slot',code:'SLOT_CONFLICT',slot:OverrideSlot,pluginId:string,previousPluginId:string}} PluginDiagnostic */
/** @typedef {(entry: PluginDiagnostic) => void} PluginLog */
/** @typedef {{characterId:string,threadId?:string,sessionId:string|null}} SessionEvent */
/** @typedef {SessionEvent & {character:Readonly<import('./agents/adapter.js').CharacterProfile>,message:string,stateless?:boolean,signal?:AbortSignal}} HookContext */
/** @typedef {{beforePrompt:HookContext, onDelta:{characterId:string,threadId?:string,text:string}, afterTurn:SessionEvent,onSessionReset:SessionEvent}} PluginEvents */
/** @typedef {{pluginId:string,data:JsonValue}} PromptContribution */
/** @typedef {{id:string,body:unknown,signal:AbortSignal}} PluginRequest */
/** @typedef {(request: PluginRequest) => unknown|Promise<unknown>} RouteHandler */
/** @typedef {() => void | Promise<void>} Cleanup */
/** @typedef {(ctx:PluginContext, config:Readonly<Record<string,unknown>>) => void|Cleanup|Promise<void|Cleanup>} ApplyPlugin */
/** @typedef {{found:false}|{found:true,data:JsonValue}} RouteResult */
/**
 * @typedef {object} PluginContext
 * @property {AbortSignal} signal Aborted when the plugin scope is removed.
 * @property {<K extends keyof Services>(name:K, impl:Services[K]) => void} provide
 * @property {<K extends keyof Services>(name:K) => Services[K]} inject
 * @property {<K extends keyof PluginEvents>(event:K, handler:(data:Readonly<PluginEvents[K]>) => K extends 'beforePrompt' ? JsonValue|void|Promise<JsonValue|void> : void|Promise<void>) => void} on
 * @property {{namespace:(pluginId:string)=>NamespaceStore}} storage
 * @property {{readCharacterField:(id:string, field:string)=>Promise<unknown>}} migration
 * @property {{registerSlot:(slot:SlotName, descriptor:SlotDescriptor)=>void}} ui
 * @property {{register:(method:RouteMethod, resource:string, handler:RouteHandler)=>void}} routes
 * @property {(fn:Cleanup) => void} onDispose
 */
/**
 * @typedef {object} Scope
 * @property {PluginManifest} manifest
 * @property {string|undefined} root
 * @property {AbortController} controller
 * @property {boolean} active
 * @property {Partial<Services>} services
 * @property {Map<keyof PluginEvents, Array<(data:never) => unknown>>} hooks
 * @property {Set<(data:never) => unknown>} pendingDeltas
 * @property {Map<string,RouteHandler>} routes
 * @property {Map<string,{slot:SlotName,descriptor:SlotDescriptor}>} ui
 * @property {Cleanup[]} cleanups
 */

/**
 * Creates a local context registry around default services; plugins never become
 * visible before apply completes. Last enabled service override wins.
 * @param {Services & {log?:PluginLog}} defaults
 */
export function createKernel({ storage, agent, log = () => {} }) {
    /** @type {Services} */
    const defaults = { storage, agent };
    /** @type {Map<string, Scope>} */
    const scopes = new Map();
    /**
     * @param {PluginManifest} manifest
     * @param {ApplyPlugin} apply
     * @param {Readonly<Record<string,unknown>>} [config]
     * @param {string} [root] Canonical plugin directory, assigned by the allowlist loader.
     * @returns {Promise<boolean>} False after any rejected initialization.
     */
    async function register(manifest, apply, config = {}, root) {
        const safe = parsePluginManifest(manifest);
        if (!safe || typeof apply !== 'function' || scopes.has(safe.id) || scopes.size >= maxScopes) {
            diagnose(log, 'initialize', 'INVALID_REGISTRATION', safe?.id);
            return false;
        }
        /** @type {Scope} */
        const scope = {
            manifest: safe, root, active: false, controller: new AbortController(),
            services: {}, hooks: new Map(), pendingDeltas: new Set(), routes: new Map(), ui: new Map(), cleanups: [],
        };
        scopes.set(safe.id, scope);
        try {
            await bounded(async () => {
                const cleanup = await apply(context(scope, inject, tag =>
                    [...scopes.values()].some(other => other !== scope && other.ui.has(tag)),
                ), config);
                if (cleanup !== undefined && typeof cleanup !== 'function') throw new TypeError('Invalid cleanup');
                if (typeof cleanup === 'function') {
                    if (scope.controller.signal.aborted) await clean(cleanup, log, safe.id);
                    else scope.cleanups.push(cleanup);
                }
            }, [scope.controller.signal], initializationTimeoutMs);
            if (root) {
                for (const { descriptor } of scope.ui.values()) {
                    await verifiedPluginFile(root, descriptor.entry);
                    if (descriptor.style) await verifiedPluginFile(root, descriptor.style);
                }
            }
            if (scope.controller.signal.aborted) return false;
            for (const slot of safe.overrides ?? []) {
                if (isDefaultUiSlot(slot)) {
                    if (![...scope.ui.values()].some(item => item.slot === slot)) throw new Error('Missing declared UI replacement');
                } else if (scope.services[slot] === undefined) {
                    throw new Error('Missing declared service replacement');
                }
            }
            scope.active = true;
            for (const slot of overrideSlots) {
                const owners = [...scopes.values()].filter(candidate => candidate.active && claims(candidate, slot));
                if (owners.length < 2 || !owners.includes(scope)) continue;
                const [previous, winner] = owners.slice(-2);
                try {
                    log({ event: 'plugin_conflict', phase: 'slot', code: 'SLOT_CONFLICT',
                        slot, pluginId: winner.manifest.id, previousPluginId: previous.manifest.id });
                } catch { /* Logging is not an app dependency. */ }
            }
            return true;
        } catch {
            diagnose(log, 'initialize', 'APPLY_FAILED', safe.id);
            if (scopes.get(safe.id) === scope) await unregister(safe.id);
            return false;
        }
    }

    /** @param {string} id @returns {Promise<boolean>} */
    async function unregister(id) {
        const scope = scopes.get(id);
        if (!scope) return false;
        scopes.delete(id);
        scope.active = false;
        scope.controller.abort();
        for (const cleanup of scope.cleanups.splice(0).reverse()) await clean(cleanup, log, id);
        return true;
    }

    /** @returns {Promise<void>} */
    async function dispose() {
        await Promise.all([...scopes.keys()].reverse().map(unregister));
    }

    /** @template {keyof Services} K @param {K} name @returns {Services[K]} */
    function inject(name) {
        const providers = [...scopes.values()].reverse();
        const owner = providers.find(scope => scope.active && scope.services[name] !== undefined);
        const override = /** @type {Services[K]|undefined} */ (owner?.services[name]);
        return override ?? defaults[name];
    }

    /** Replaces the host fallback for future requests, independently of plugin scopes. @param {AgentService} next */
    function setDefaultAgent(next) {
        if (!validService('agent', next)) throw new TypeError('Invalid default Agent service');
        defaults.agent = next;
    }

    /** @param {string} id */
    function isActive(id) {
        return scopes.get(id)?.active === true;
    }

    /** @param {HookContext} payload @returns {Promise<PromptContribution[]>} */
    async function collectContext(payload) {
        const outcomes = await Promise.all([...scopes.values()].filter(scope => scope.active).flatMap(scope =>
            (scope.hooks.get('beforePrompt') ?? []).map(async handler => {
                try {
                    const data = await bounded(signal => handler(/** @type {never} */ (Object.freeze({
                        ...payload, character: Object.freeze({ ...payload.character }), signal,
                    }))), hookSignals(scope, payload.signal), hookTimeoutMs);
                    if (data === undefined || data === null || !scope.active || payload.signal?.aborted) return undefined;
                    return { scope, value: serialize(data, maxContextBytes) };
                } catch {
                    if (scope.active && !payload.signal?.aborted) diagnose(log, 'beforePrompt', 'HOOK_FAILED', scope.manifest.id);
                    return undefined;
                }
            })));
        /** @type {PromptContribution[]} */
        const contributions = [];
        if (payload.signal?.aborted) return contributions;
        let remaining = maxContextBytes;
        for (const outcome of outcomes) {
            if (!outcome?.scope.active || outcome.value.bytes > remaining) continue;
            remaining -= outcome.value.bytes;
            contributions.push({ pluginId: outcome.scope.manifest.id, data: outcome.value.data });
        }
        return contributions;
    }

    /**
     * @template {Exclude<keyof PluginEvents,'beforePrompt'>} K
     * @param {K} event @param {PluginEvents[K]} payload @returns {Promise<void>}
     */
    async function emit(event, payload) {
        const snapshot = Object.freeze({ ...payload });
        await Promise.all([...scopes.values()].filter(scope => scope.active).flatMap(scope =>
            (scope.hooks.get(event) ?? []).map(async handler => {
                // A lagging delta handler cannot queue unbounded work behind the chat stream.
                const delta = event === 'onDelta';
                if (delta && scope.pendingDeltas.has(handler)) return;
                if (delta) scope.pendingDeltas.add(handler);
                let started = false;
                try {
                    await bounded(() => {
                        started = true;
                        const invoke = () => handler(/** @type {never} */ (snapshot));
                        return delta ? deltaWork(scope, handler, invoke) : invoke();
                    }, hookSignals(scope), hookTimeoutMs);
                } catch {
                    if (scope.active) diagnose(log, event, 'HOOK_FAILED', scope.manifest.id);
                } finally {
                    if (delta && !started) scope.pendingDeltas.delete(handler);
                }
            })));
    }

    /** @returns {DefaultUiClaim[]} */
    function getDefaultUi() {
        const active = [...scopes.values()].reverse().filter(scope => scope.active);
        return defaultUiSlots.flatMap(slot => {
            const owner = active.find(scope => claims(scope, slot));
            if (!owner) return [];
            return [{ slot, pluginId: owner.manifest.id, action: owner.manifest.hides?.includes(slot) ? 'hide' : 'override' }];
        });
    }

    /** @returns {PublicSlot[]} */
    function getSlots() {
        const replacements = new Map(getDefaultUi().filter(claim => claim.action === 'override')
            .map(claim => [claim.slot, claim.pluginId]));
        return [...scopes].flatMap(([pluginId, scope]) => !scope.active || !scope.root ? [] : [...scope.ui.values()]
            .filter(({ slot }) => !isDefaultUiSlot(slot) || replacements.get(slot) === pluginId)
            .map(({ slot, descriptor }) => {
                const prefix = '/plugin-assets/' + pluginId + '/';
                return {
                    pluginId, slot, tag: descriptor.tag, entry: prefix + descriptor.entry,
                    ...(descriptor.style ? { style: prefix + descriptor.style } : {}),
                };
            }));
    }

    /** @param {string} pluginId @param {string} filename @returns {Promise<string|undefined>} */
    async function asset(pluginId, filename) {
        const scope = scopes.get(pluginId);
        if (!scope?.active || !scope.root || ![...scope.ui.values()].some(({ descriptor }) =>
            descriptor.entry === filename || descriptor.style === filename)) return undefined;
        try {
            const path = await verifiedPluginFile(scope.root, filename);
            return scope.active ? path : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * @param {string} pluginId @param {string} resource @param {string} method
     * @param {PluginRequest} request @returns {Promise<RouteResult>}
     */
    async function dispatchRoute(pluginId, resource, method, request) {
        const scope = scopes.get(pluginId);
        const handler = scope?.active && scope.routes.get(method + ':' + resource);
        if (!scope || !handler) return { found: false };
        try {
            const out = await bounded(signal => handler({ ...request, signal }), hookSignals(scope, request.signal), routeTimeoutMs);
            return scope.active ? { found: true, data: serialize(out ?? null, maxRouteBytes).data } : { found: false };
        } catch (error) {
            if (request.signal.aborted) throw appError('STREAM_ABORTED');
            if (!scope.active) return { found: false };
            if (error instanceof AppError && error.status >= 400 && error.status < 500) throw error;
            diagnose(log, 'route', 'HANDLER_FAILED', pluginId);
            throw appError('INTERNAL_ERROR');
        }
    }

    return { register, unregister, dispose, inject, setDefaultAgent, isActive, collectContext, emit, getDefaultUi, getSlots, asset, dispatchRoute };
}

/** @param {unknown} value @returns {PluginManifest | undefined} */
export function parsePluginManifest(value) {
    if (!isObject(value)) return undefined;
    const { id, name, version, entry, slots: declaredSlots, permissions: declaredPermissions } = value;
    if (!isPluginId(id) || typeof name !== 'string' || !name.trim() || name.length > 80
        || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version) || version.length > 40
        || !isAsset(entry, 'js') || !uniqueMembers(declaredSlots, slots) || !uniqueMembers(declaredPermissions, permissions)) {
        return undefined;
    }
    const overrides = value.overrides === undefined ? [] : value.overrides;
    const hides = value.hides === undefined ? [] : value.hides;
    if (!uniqueMembers(overrides, overrideSlots) || !uniqueMembers(hides, defaultUiSlots)
        || hides.some(slot => overrides.includes(slot))
        || overrides.some(slot => isDefaultUiSlot(slot)
            ? !declaredSlots.includes(slot) || !declaredPermissions.includes('ui')
            : !declaredPermissions.includes(servicePermission(slot)))
        || (hides.length && !declaredPermissions.includes('ui'))
        || defaultUiSlots.some(slot => declaredSlots.includes(slot) && !overrides.includes(slot))) return undefined;
    return { id, name, version, entry, slots: [...declaredSlots], permissions: [...declaredPermissions],
        overrides: [...overrides], hides: [...hides] };
}

/** @param {string} slot @returns {slot is DefaultUiSlot} */
function isDefaultUiSlot(slot) {
    return defaultUiSlots.some(candidate => candidate === slot);
}

/** @param {keyof Services} name @returns {Permission} */
function servicePermission(name) {
    return name === 'agent' ? 'provide:agent' : 'provide:storage';
}

/** @param {Scope} scope @param {OverrideSlot} slot */
function claims(scope, slot) {
    if (!isDefaultUiSlot(slot)) return scope.services[slot] !== undefined;
    return scope.manifest.hides?.includes(slot) || (scope.root && scope.manifest.overrides?.includes(slot));
}

/** @param {unknown} value @returns {value is string} */
export function isPluginId(value) {
    return typeof value === 'string' && value.length <= 48 && idPattern.test(value) && !Object.hasOwn(Object.prototype, value);
}

/**
 * Resolves a known direct file only. Symlinks and junctions are rejected even
 * when they point inside the plugin tree.
 * @param {string} directory @param {string} filename @returns {Promise<string>}
 */
export async function verifiedPluginFile(directory, filename) {
    if (basename(filename) !== filename || /[\\/:]/.test(filename)) throw new Error('File name rejected');
    const path = join(directory, filename);
    const entry = await lstat(path);
    const canonical = await realpath(path);
    if (!entry.isFile() || entry.isSymbolicLink() || relative(directory, dirname(canonical)) || basename(canonical) !== filename) {
        throw new Error('Plugin file rejected');
    }
    return canonical;
}

/** @param {PluginLog} log @param {string} phase @param {string} code @param {string} [pluginId] */
export function diagnose(log, phase, code, pluginId) {
    try { log({ event: 'plugin_failed', phase, code, ...(pluginId ? { pluginId } : {}) }); } catch { /* Logging is not an app dependency. */ }
}

/**
 * @template T
 * @param {(signal:AbortSignal) => T|Promise<T>} task
 * @param {AbortSignal[]} signals
 * @param {number} ms
 * @returns {Promise<T>}
 */
export async function bounded(task, signals, ms) {
    const timer = new AbortController();
    const signal = AbortSignal.any([...signals, timer.signal]);
    if (signal.aborted) throw signal.reason;
    const timeout = setTimeout(() => timer.abort(), ms);
    let detach = () => {};
    try {
        /** @type {Promise<T>} */
        const interrupted = new Promise((_, reject) => {
            const stop = () => reject(signal.reason);
            signal.addEventListener('abort', stop, { once: true });
            detach = () => signal.removeEventListener('abort', stop);
        });
        /** @type {Promise<T>} */
        let execution;
        try { execution = Promise.resolve(task(signal)); }
        catch (error) { execution = Promise.reject(error); }
        return await Promise.race([interrupted, execution]);
    } finally {
        clearTimeout(timeout);
        detach();
    }
}

/** @param {Scope} scope @param {Kernel['inject']} inject @param {(tag:string)=>boolean} tagInUse @returns {PluginContext} */
function context(scope, inject, tagInUse) {
    const { manifest, controller, services, hooks, ui, routes, cleanups } = scope;
    const { signal } = controller;
    /** @param {Permission} [permission] */
    function ensure(permission) {
        if (signal.aborted) throw new Error('Plugin removed');
        if (permission && !manifest.permissions.includes(permission)) throw new Error('Plugin permission missing');
    }
    return Object.freeze(/** @type {PluginContext} */ ({
        signal,
        provide(name, impl) {
            if (name !== 'agent' && name !== 'storage') throw new Error('Unknown service');
            ensure(servicePermission(name));
            if (scope.active || !validService(name, impl) || services[name] !== undefined) throw new Error('Invalid or duplicate service');
            Object.assign(services, { [name]: impl });
        },
        inject(name) {
            if (name !== 'agent' && name !== 'storage') throw new Error('Unknown service');
            ensure(servicePermission(name));
            return services[name] ?? inject(name);
        },
        on(event, handler) {
            ensure('hooks');
            if (!events.includes(event) || typeof handler !== 'function') throw new Error('Invalid hook');
            const handlers = hooks.get(event) ?? [];
            if (handlers.length >= maxEffectsPerKind) throw new Error('Too many hooks');
            handlers.push(handler);
            hooks.set(event, handlers);
        },
        storage: Object.freeze({
            namespace(pluginId) {
                ensure('storage');
                if (pluginId !== manifest.id) throw new Error('Foreign plugin namespace');
                /** @returns {NamespaceStore} */
                function access() {
                    ensure('storage');
                    return inject('storage').namespace(pluginId);
                }
                return Object.freeze({
                    /** @param {string} key */
                    get: key => access().get(key),
                    /** @param {string} key @param {JsonValue} value @param {AbortSignal} [operation] */
                    set: (key, value, operation) => access().set(key, value, operation ? AbortSignal.any([signal, operation]) : signal),
                    /** @param {string} key */
                    delete: key => access().delete(key),
                });
            },
        }),
        migration: Object.freeze({
            readCharacterField(id, field) {
                ensure('migrate');
                return inject('storage').readLegacyField(id, field);
            },
        }),
        ui: Object.freeze({
            registerSlot(slot, descriptor) {
                ensure('ui');
                if (scope.active || !manifest.slots.includes(slot) || !isDescriptor(descriptor, manifest.id)
                    || descriptor.entry === manifest.entry || tagInUse(descriptor.tag) || ui.has(descriptor.tag) || ui.size >= maxEffectsPerKind) throw new Error('Invalid or duplicate UI slot');
                ui.set(descriptor.tag, { slot, descriptor: { ...descriptor } });
            },
        }),
        routes: Object.freeze({
            register(method, resource, handler) {
                ensure('routes');
                const key = method + ':' + resource;
                if (!methods.includes(method) || !isPluginId(resource) || typeof handler !== 'function'
                    || routes.has(key) || routes.size >= maxEffectsPerKind) throw new Error('Invalid or duplicate plugin route');
                routes.set(key, handler);
            },
        }),
        onDispose(fn) {
            ensure();
            if (typeof fn !== 'function' || cleanups.length >= maxEffectsPerKind) throw new Error('Invalid or excess cleanup');
            cleanups.push(fn);
        },
    }));
}

/** @param {Scope} scope @param {(data:never)=>unknown} handler @param {()=>unknown} invoke */
function deltaWork(scope, handler, invoke) {
    let pending = false;
    try {
        const value = invoke();
        if (value && typeof value === 'object' && 'then' in value) {
            const work = Promise.resolve(value).finally(() => scope.pendingDeltas.delete(handler));
            pending = true;
            return work;
        }
        return value;
    } finally {
        if (!pending) scope.pendingDeltas.delete(handler);
    }
}

/** @param {Scope} scope @param {AbortSignal} [signal] @returns {AbortSignal[]} */
function hookSignals(scope, signal) {
    return signal ? [scope.controller.signal, signal] : [scope.controller.signal];
}

/** @param {Cleanup} cleanup @param {PluginLog} log @param {string} id */
async function clean(cleanup, log, id) {
    try { await bounded(cleanup, [], hookTimeoutMs); } catch { diagnose(log, 'dispose', 'CLEANUP_FAILED', id); }
}

/** @param {unknown} data @param {number} maximum @returns {{data:JsonValue,bytes:number}} */
function serialize(data, maximum) {
    const text = JSON.stringify(data);
    if (typeof text !== 'string') throw new TypeError('Not JSON');
    const bytes = Buffer.byteLength(text);
    if (bytes > maximum) throw new RangeError('Plugin JSON data exceeds limit');
    return { data: JSON.parse(text), bytes };
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @template {string} T @param {unknown} value @param {readonly T[]} known @returns {value is T[]} */
function uniqueMembers(value, known) {
    return Array.isArray(value) && value.length <= known.length && new Set(value).size === value.length
        && value.every(member => known.includes(member));
}

/** @param {unknown} entry @param {'js'|'css'} kind @returns {entry is string} */
function isAsset(entry, kind) {
    return typeof entry === 'string' && assetPattern.test(entry)
        && (kind === 'js' ? /\.m?js$/.test(entry) : entry.endsWith('.css'));
}

/** @param {unknown} descriptor @param {string} id @returns {descriptor is SlotDescriptor} */
function isDescriptor(descriptor, id) {
    return isObject(descriptor) && typeof descriptor.tag === 'string'
        && descriptor.tag.startsWith(id + '-') && !descriptor.tag.startsWith('write-') && isPluginId(descriptor.tag)
        && isAsset(descriptor.entry, 'js') && (descriptor.style === undefined || isAsset(descriptor.style, 'css'));
}

/** @param {keyof Services} name @param {unknown} value */
function validService(name, value) {
    if (!isObject(value)) return false;
    if (name === 'agent') return isPluginId(value.id) && typeof value.run === 'function'
        && (!('stream' in value.run) || value.run.stream === undefined || typeof value.run.stream === 'function')
        && (value.stateless === undefined || typeof value.stateless === 'boolean');
    const { characters, threads, archive } = value;
    return isRecordStore(characters) && (threads === undefined || isRecordStore(threads))
        && (archive === undefined || (isObject(archive) && typeof archive.read === 'function'))
        && typeof value.namespace === 'function' && typeof value.readLegacyField === 'function';
}

/** @param {unknown} value */
function isRecordStore(value) {
    return isObject(value) && ['get', 'list', 'save', 'delete'].every(member => typeof value[member] === 'function');
}
