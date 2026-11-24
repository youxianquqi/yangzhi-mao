// Owns JSON record validation, forward-compatible fields and atomic replacement.
// The original role file keeps its default thread; extra threads have independent commit points.
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROVIDER, LIMITS } from './config.js';
import { AppError, appError } from './errors.js';
import { createArchiveStore, isStoredMessage, removeFiles, validRefs } from './history-archive.js';
import { atomicJson, privateDirectory, readJson } from './private-json.js';

const characterIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const providerPattern = /^[a-z][a-z0-9-]{0,63}$/;
const namespaceKeyPattern = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const recordExtension = '.json';
const profileFields = ['name', 'description', 'greeting', 'updatedAt'];
const coreFields = new Set(['id', 'provider', 'inactiveSessions', 'messages', 'archive', 'sessionId', 'revisionId', 'defaultThreadDeleted', ...profileFields]);
const namespaceFileLimit = 64 * 1024;

/** @typedef {{role: 'user'|'assistant', text: string}} Message */
/** @typedef {import('./history-archive.js').ArchiveRef} ArchiveRef */
/** @typedef {import('./history-archive.js').ArchiveChanges} ArchiveChanges */
/** @typedef {import('./history-archive.js').ArchiveReader} ArchiveReader */
/** @typedef {{sessionId: string|null, messages: Message[], archive?: ArchiveRef[]}} AgentSession */
/** @typedef {AgentSession & {id: string, provider: string, inactiveSessions: Record<string, AgentSession>, revisionId?: string}} Conversation */
/** @typedef {Conversation & {name: string, description: string, greeting: string, updatedAt: string, defaultThreadDeleted?: boolean}} CharacterRecord */
/** @typedef {Conversation & {name: string, createdAt: string, updatedAt: string}} ThreadRecord */
/** @typedef {{get: (roleId:string, threadId:string) => Promise<ThreadRecord>, list: (roleId:string) => Promise<ThreadRecord[]>, save: (roleId:string, thread:ThreadRecord, signal?:AbortSignal, changes?:ArchiveChanges) => Promise<ThreadRecord|void>, delete: (roleId:string, threadId:string) => Promise<void>}} ThreadStore */
/** @typedef {{get: (id: string) => Promise<CharacterRecord>, list: () => Promise<CharacterRecord[]>, save: (record: CharacterRecord, signal?: AbortSignal, changes?:ArchiveChanges) => Promise<CharacterRecord|void>, delete: (id: string) => Promise<void>}} CharacterStore */
/** @typedef {import('../types/json.js').JsonValue} JsonValue */
/** @typedef {{get: (key:string) => Promise<unknown>, set: (key:string,value:JsonValue,signal?:AbortSignal) => Promise<void>, delete: (key:string) => Promise<void>}} NamespaceStore */
/** @typedef {{characters: CharacterStore, threads?: ThreadStore, archive?: ArchiveReader, namespace: (pluginId: string) => NamespaceStore, readLegacyField: (id: string, field: string) => Promise<unknown>}} StorageService */

/** @param {unknown} id @returns {string} Canonical UUID for filenames and locks. */
export function normalizeCharacterId(id) {
    if (typeof id !== 'string' || !characterIdPattern.test(id)) throw appError('CHARACTER_NOT_FOUND');
    return id.toLowerCase();
}

/** @param {unknown} id @returns {string} Canonical thread UUID; unrelated role/thread combinations are rejected by storage. */
export function normalizeThreadId(id) {
    if (typeof id !== 'string' || !characterIdPattern.test(id)) throw appError('THREAD_NOT_FOUND');
    return id.toLowerCase();
}

/** @param {unknown} value @returns {value is string} */
export function isProviderId(value) {
    return typeof value === 'string' && providerPattern.test(value) && !Object.hasOwn(Object.prototype, value);
}

/** @param {string} dataDir @returns {Promise<StorageService>} */
export async function createStorageService(dataDir) {
    const directory = join(dataDir, 'characters');
    await privateDirectory(directory);
    const archive = createArchiveStore(dataDir);
    return {
        archive: { read: archive.read },
        characters: {
            get: id => readRecord(directory, id),
            list: () => listRecords(directory),
            save: async (record, signal, changes) => {
                const id = normalizeCharacterId(record.id);
                if (!isRecord(record, id)) throw appError('STORAGE_ERROR');
                return archive.commit(id, id, recordPath(directory, id), record, signal, changes);
            },
            delete: async id => {
                const key = normalizeCharacterId(id);
                const previous = await readRecord(directory, key);
                const obsolete = await archive.obsoleteShards(key, key, previous);
                await deleteJson(recordPath(directory, key), true);
                await removeFiles(obsolete);
            },
        },
        threads: createThreadStore(dataDir, archive),
        namespace: pluginId => createNamespace(dataDir, pluginId),
        readLegacyField: async (id, field) => {
            if (typeof field !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,48}$/.test(field) || coreFields.has(field)) {
                throw appError('INVALID_INPUT');
            }
            const record = await readRecord(directory, id);
            return Object.hasOwn(record, field) ? record[field] : undefined;
        },
    };
}

function isRecord(record, id) {
    return record?.id === id && profileFields.every(key => typeof record[key] === 'string')
        && isConversation(record)
        && (record.defaultThreadDeleted === undefined || typeof record.defaultThreadDeleted === 'boolean');
}

function isConversation(record) {
    const provider = record?.provider === undefined ? DEFAULT_PROVIDER : record.provider;
    return isProviderId(provider) && isSession(record)
        && (record.inactiveSessions === undefined || isInactiveSessions(record.inactiveSessions, provider))
        && (record.revisionId === undefined || (typeof record.revisionId === 'string' && characterIdPattern.test(record.revisionId)));
}

function isSession(data) {
    return (data?.sessionId === null || (typeof data?.sessionId === 'string' && data.sessionId.trim() !== ''))
        && Array.isArray(data.messages)
        && data.messages.every(isStoredMessage) && (data.archive === undefined || validRefs(data.archive));
}

function isInactiveSessions(sessions, provider) {
    return sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)
        && Object.entries(sessions).every(([id, session]) => isProviderId(id) && id !== provider && isSession(session));
}

function recordPath(directory, id) {
    return join(directory, id + recordExtension);
}

async function readRecord(directory, id) {
    const key = normalizeCharacterId(id);
    try {
        const record = await readJson(recordPath(directory, key));
        if (record === undefined) throw appError('CHARACTER_NOT_FOUND');
        if (!isRecord(record, key)) throw appError('STORAGE_ERROR');
        // Unrecognized archival fields are retained but never exposed by the role HTTP response.
        return { ...record, provider: record.provider ?? DEFAULT_PROVIDER, inactiveSessions: record.inactiveSessions ?? {} };
    } catch (cause) {
        throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
    }
}

async function listRecords(directory) {
    try {
        const files = await readdir(directory);
        const ids = files.filter(name => name.endsWith(recordExtension))
            .map(name => name.slice(0, -recordExtension.length)).filter(name => characterIdPattern.test(name));
        return await Promise.all(ids.map(id => readRecord(directory, id)));
    } catch (cause) {
        throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
    }
}

/** @param {string} dataDir @param {ReturnType<typeof createArchiveStore>} archive @returns {ThreadStore} */
function createThreadStore(dataDir, archive) {
    const base = join(dataDir, 'threads');

    /** @param {string} roleId @param {boolean} [create] */
    async function directoryFor(roleId, create = false) {
        const directory = join(base, normalizeCharacterId(roleId));
        if (create) {
            await privateDirectory(base);
            await privateDirectory(directory);
            return directory;
        }
        try {
            if (!(await lstat(base)).isDirectory() || !(await lstat(directory)).isDirectory()) throw appError('STORAGE_ERROR');
            return directory;
        } catch (cause) {
            if (cause?.code === 'ENOENT') return undefined;
            throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
        }
    }

    /** @param {string} directory @param {string} key @returns {Promise<ThreadRecord|undefined>} */
    async function get(directory, key) {
        try {
            const thread = await readJson(recordPath(directory, key));
            if (thread === undefined) return undefined;
            if (!isThread(thread, key)) throw appError('STORAGE_ERROR');
            return { ...thread, provider: thread.provider ?? DEFAULT_PROVIDER, inactiveSessions: thread.inactiveSessions ?? {} };
        } catch (cause) {
            throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
        }
    }

    return {
        get: async (roleId, threadId) => {
            const key = extraThreadId(roleId, threadId);
            const directory = await directoryFor(roleId);
            const record = directory && await get(directory, key);
            if (!record) throw appError('THREAD_NOT_FOUND');
            return record;
        },
        list: async roleId => {
            const directory = await directoryFor(roleId);
            if (!directory) return [];
            try {
                const files = await readdir(directory);
                const ids = files.filter(name => name.endsWith(recordExtension))
                    .map(name => name.slice(0, -recordExtension.length))
                    .filter(id => characterIdPattern.test(id) && id !== roleId);
                // A thread may be deleted between readdir and read by another process.
                return (await Promise.all(ids.map(id => get(directory, id)))).filter(Boolean);
            } catch (cause) {
                if (cause?.code === 'ENOENT') return [];
                throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
            }
        },
        save: async (roleId, record, signal, changes) => {
            const key = extraThreadId(roleId, record.id);
            if (!isThread(record, key)) throw appError('STORAGE_ERROR');
            const directory = await directoryFor(roleId, true);
            return archive.commit(normalizeCharacterId(roleId), key, recordPath(directory, key), record, signal, changes);
        },
        delete: async (roleId, threadId) => {
            const key = extraThreadId(roleId, threadId);
            const directory = await directoryFor(roleId);
            if (!directory) throw appError('THREAD_NOT_FOUND');
            const previous = await get(directory, key);
            const obsolete = await archive.obsoleteShards(normalizeCharacterId(roleId), key, previous);
            await deleteJson(recordPath(directory, key), true, 'THREAD_NOT_FOUND');
            await removeFiles(obsolete);
        },
    };
}

function extraThreadId(roleId, threadId) {
    const key = normalizeThreadId(threadId);
    if (key === normalizeCharacterId(roleId)) throw appError('THREAD_NOT_FOUND');
    return key;
}

function isThread(record, key) {
    return record?.id === key && typeof record.name === 'string' && record.name.trim()
        && record.name.length <= LIMITS.threadNameLength && typeof record.createdAt === 'string'
        && typeof record.updatedAt === 'string' && isConversation(record);
}

/** @returns {NamespaceStore} */
function createNamespace(dataDir, pluginId) {
    if (!isProviderId(pluginId)) throw appError('INVALID_INPUT');
    const base = join(dataDir, 'plugin-data');
    const directory = join(base, pluginId);
    async function filepath(key) {
        if (typeof key !== 'string' || !namespaceKeyPattern.test(key)) throw appError('INVALID_INPUT');
        await privateDirectory(base);
        await privateDirectory(directory);
        return join(directory, key + recordExtension);
    }
    return {
        get: async key => {
            const file = await filepath(key);
            try { return await readJson(file, namespaceFileLimit); }
            catch (cause) { throw appError('STORAGE_ERROR', { cause }); }
        },
        set: async (key, value, signal) => {
            const file = await filepath(key);
            let json;
            try { json = JSON.stringify(value); } catch { throw appError('INVALID_INPUT'); }
            if (json === undefined) throw appError('INVALID_INPUT');
            if (new TextEncoder().encode(json).length > namespaceFileLimit) throw appError('PAYLOAD_TOO_LARGE');
            await atomicJson(file, json, signal);
        },
        delete: async key => deleteJson(await filepath(key), false),
    };
}

async function deleteJson(file, mustExist, missingCode = /** @type {'CHARACTER_NOT_FOUND'|'THREAD_NOT_FOUND'} */ ('CHARACTER_NOT_FOUND')) {
    try { await unlink(file); }
    catch (cause) {
        if (cause?.code === 'ENOENT') {
            if (mustExist) throw appError(missingCode);
            return;
        }
        throw appError('STORAGE_ERROR', { cause });
    }
}
