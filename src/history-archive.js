// Immutable history shards are staged before the main-record rename. Only references
// in that committed record make a shard visible to readers.
import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './config.js';
import { AppError, appError } from './errors.js';
import { atomicJson, privateDirectory, readJson } from './private-json.js';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const providerId = /^[a-z][a-z0-9-]{0,63}$/;

/** @typedef {import('./storage.js').Message} Message */
/** @typedef {import('./storage.js').AgentSession} AgentSession */
/** @typedef {import('./storage.js').Conversation} Conversation */
/** @typedef {{id:string,end:number}} ArchiveRef Exclusive end at the absolute timeline offset. */
/** @typedef {{roleId:string,threadId:string,provider:string}} ArchiveScope */
/** @typedef {{replace?:{id:string,messages:Message[]},prune?:boolean}} ArchiveChanges */
/** @typedef {{read:(scope:ArchiveScope,id:string,count:number)=>Promise<Message[]|undefined>}} ArchiveReader */

/** @param {unknown} refs @returns {refs is ArchiveRef[]} */
export function validRefs(refs) {
    if (!Array.isArray(refs)) return false;
    const seen = new Set();
    let previous = 0;
    for (const ref of refs) {
        if (!ref || typeof ref.id !== 'string' || !uuid.test(ref.id) || seen.has(ref.id)
            || !Number.isSafeInteger(ref.end) || ref.end <= previous || ref.end - previous > LIMITS.historyShardMessages) return false;
        seen.add(ref.id);
        previous = ref.end;
    }
    return true;
}

/** @param {unknown} message @returns {message is Message} */
export function isStoredMessage(message) {
    return !!message && typeof message === 'object' && 'role' in message && 'text' in message
        && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string';
}

/** @param {AgentSession} session */
export function archivedCount(session) {
    return session.archive?.at(-1)?.end ?? 0;
}

/** @param {AgentSession} session */
export function timelineCount(session) {
    return archivedCount(session) + session.messages.length;
}

/** Finds the first shard ending after an absolute index. @param {ArchiveRef[]} refs @param {number} index */
export function shardIndex(refs, index) {
    let left = 0;
    let right = refs.length;
    while (left < right) {
        const middle = left + Math.floor((right - left) / 2);
        if (refs[middle].end > index) right = middle;
        else left = middle + 1;
    }
    return left;
}

/**
 * Reads at most the requested slices. A missing shard is distinguishable from
 * a malformed one, which helps concurrent readers retry an older revision.
 * @param {ArchiveReader|undefined} reader @param {ArchiveScope} scope @param {AgentSession} session
 */
export function timelineReader(reader, scope, session) {
    /** @param {number} index @returns {Promise<Message[]|undefined>} */
    async function readShard(index) {
        const ref = session.archive?.[index];
        if (!reader || !ref) throw appError('STORAGE_ERROR');
        return reader.read(scope, ref.id, ref.end - (session.archive[index - 1]?.end ?? 0));
    }

    /** @param {number} start @param {number} end @returns {Promise<Message[]|undefined>} */
    async function range(start, end) {
        if (start === end) return [];
        const refs = session.archive ?? [];
        const archived = archivedCount(session);
        /** @type {Message[]} */
        const result = [];
        if (start < archived) {
            for (let index = shardIndex(refs, start); index < refs.length; index++) {
                const shardStart = refs[index - 1]?.end ?? 0;
                if (shardStart >= end) break;
                const shard = await readShard(index);
                if (!shard) return undefined;
                result.push(...shard.slice(Math.max(0, start - shardStart), end - shardStart));
            }
        }
        if (end > archived) result.push(...session.messages.slice(Math.max(0, start - archived), end - archived));
        return result;
    }

    return { readShard, range };
}

/** @param {string} dataDir */
export function createArchiveStore(dataDir) {
    const root = join(dataDir, 'archives');

    /** @param {ArchiveScope} scope @returns {string[]} */
    function directories({ roleId, threadId, provider }) {
        if (!uuid.test(roleId) || !uuid.test(threadId) || !providerId.test(provider)) throw appError('STORAGE_ERROR');
        const role = join(root, roleId);
        const thread = join(role, threadId);
        return [root, role, thread, join(thread, provider)];
    }

    /** @type {ArchiveReader['read']} */
    async function read(scope, id, count) {
        if (!uuid.test(id) || !Number.isInteger(count) || count < 1 || count > LIMITS.historyShardMessages) throw appError('STORAGE_ERROR');
        const dirs = directories(scope);
        try {
            for (const directory of dirs) {
                if (!(await lstat(directory)).isDirectory()) throw appError('STORAGE_ERROR');
            }
            const shard = await readJson(join(dirs.at(-1), id + '.json'));
            if (shard === undefined) return undefined;
            if (!Array.isArray(shard) || shard.length !== count || !shard.every(isStoredMessage)) throw appError('STORAGE_ERROR');
            return shard;
        } catch (cause) {
            if (cause?.code === 'ENOENT') return undefined;
            throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
        }
    }

    /**
     * @template {Conversation} T
     * @param {string} roleId @param {string} threadId @param {string} file
     * @param {T} record @param {AbortSignal} [signal] @param {ArchiveChanges} [changes]
     * @returns {Promise<T>}
     */
    async function commit(roleId, threadId, file, record, signal, changes) {
        /** @type {string[]} */
        const staged = [];
        const next = { ...record, inactiveSessions: { ...record.inactiveSessions } };
        let obsolete;
        try {
            const active = await stage({ roleId, threadId, provider: record.provider }, record, changes?.replace);
            next.messages = active.messages;
            if (active.archive?.length) next.archive = active.archive;
            else delete next.archive;
            for (const [provider, session] of Object.entries(next.inactiveSessions)) {
                next.inactiveSessions[provider] = await stage({ roleId, threadId, provider }, session);
            }
            obsolete = changes?.prune || changes?.replace
                ? await obsoleteShards(roleId, threadId, await readJson(file), next) : [];
            await atomicJson(file, JSON.stringify(next, null, 2) + '\n', signal);
        } catch (cause) {
            await removeFiles(staged);
            throw cause instanceof AppError ? cause : appError('STORAGE_ERROR', { cause });
        }
        await removeFiles(obsolete);
        return next;

        /** @param {ArchiveScope} scope @param {AgentSession} session @param {ArchiveChanges['replace']} [replace] */
        async function stage(scope, session, replace) {
            if (!replace && session.messages.length <= LIMITS.historyMessages) return session;
            const directoriesToCreate = directories(scope);
            for (const dir of directoriesToCreate) await privateDirectory(dir);
            const directory = directoriesToCreate.at(-1);
            const refs = session.archive?.slice() ?? [];
            if (replace) {
                const index = refs.findIndex(ref => ref.id === replace.id);
                const ref = refs[index];
                if (!ref || replace.messages.length !== ref.end - (refs[index - 1]?.end ?? 0)
                    || !replace.messages.every(isStoredMessage)) throw appError('STORAGE_ERROR');
                refs[index] = { id: await stageFile(replace.messages), end: ref.end };
            }
            let offset = 0;
            let end = refs.at(-1)?.end ?? 0;
            while (session.messages.length - offset > LIMITS.historyMessages) {
                const chunk = session.messages.slice(offset, offset + LIMITS.historyShardMessages);
                end += chunk.length;
                refs.push({ id: await stageFile(chunk), end });
                offset += chunk.length;
            }
            return { ...session, messages: session.messages.slice(offset), archive: refs };

            /** @param {Message[]} messages */
            async function stageFile(messages) {
                const id = randomUUID();
                const path = join(directory, id + '.json');
                await atomicJson(path, JSON.stringify(messages) + '\n', signal);
                staged.push(path);
                return id;
            }
        }
    }

    /**
     * Shard cleanup runs under the owning write lock and only after the record commit;
     * readers holding the prior snapshot can retry against the new revision.
     * @param {string} roleId @param {string} threadId @param {Conversation|undefined} previous @param {Conversation} [next]
     */
    async function obsoleteShards(roleId, threadId, previous, next) {
        if (!previous) return [];
        const retained = next ? sessions(next) : new Map();
        const paths = [];
        for (const [provider, session] of sessions(previous)) {
            if (!session.archive?.length || !validRefs(session.archive) || typeof provider !== 'string' || !providerId.test(provider)) continue;
            const keep = new Set(retained.get(provider)?.archive?.map(ref => ref.id));
            const dirs = directories({ roleId, threadId, provider });
            try {
                for (const dir of dirs) {
                    if (!(await lstat(dir)).isDirectory()) throw appError('STORAGE_ERROR');
                }
                const directory = dirs.at(-1);
                for (const ref of session.archive) {
                    if (!keep.has(ref.id)) paths.push(join(directory, ref.id + '.json'));
                }
            } catch {
                // Missing or inaccessible obsolete files do not prevent deleting the record itself.
            }
        }
        return paths;
    }

    return { read, commit, obsoleteShards };
}

/** @param {Conversation} record */
function sessions(record) {
    return new Map([[record.provider, record], ...Object.entries(record.inactiveSessions ?? {})]);
}

/** @param {string[]} paths */
export async function removeFiles(paths) {
    await Promise.allSettled(paths.map(path => rm(path, { force: true })));
}
