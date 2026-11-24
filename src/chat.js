// Owns role, thread and chat transactions; slots never own locking or commit.
// The original role file and every additional thread have independent write locks.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './config.js';
import { createCharacterLock } from './character-lock.js';
import { appError } from './errors.js';
import { archivedCount, shardIndex, timelineCount, timelineReader } from './history-archive.js';
import { normalizeCharacterId, normalizeThreadId } from './storage.js';

/** @typedef {import('./kernel.js').Kernel} Kernel */
/** @typedef {import('./storage.js').CharacterRecord} CharacterRecord */
/** @typedef {import('./storage.js').ThreadRecord} ThreadRecord */
/** @typedef {import('./storage.js').Conversation} Conversation */
/** @typedef {import('./storage.js').StorageService} StorageService */
/** @typedef {import('./storage.js').Message} Message */
/** @typedef {import('./agents/adapter.js').AgentRequest} AgentRequest */
/** @typedef {import('./agents/adapter.js').AgentAdapter} AgentAdapter */
/** @typedef {import('./agents/adapter.js').AgentService} AgentService */
/** @typedef {import('./history-archive.js').ArchiveChanges} ArchiveChanges */
/** @typedef {ReturnType<typeof timelineReader>} TimelineReader */
/** @typedef {{signal?: AbortSignal, onStart: () => void, onDelta: (text: string) => void}} StreamOptions */
/** @typedef {CharacterRecord & {threadId: string, threadName: string, revision: string, total: number}} ThreadView */
/** @typedef {{id:string,name:string,updatedAt:string,messageCount:number}} ThreadSummary */
/** @typedef {{messages:Message[],start:number,total:number,revision:string}} MessagePage */

const defaultThreadName = '默认剧情线';

/** @param {{dataDir: string, kernel: Kernel}} options */
export async function createChatService({ dataDir, kernel }) {
    const locks = await createCharacterLock(dataDir);
    const membership = await createCharacterLock(join(dataDir, 'thread-membership'));
    const cwd = join(dataDir, 'agent-workspace');
    await mkdir(cwd, { recursive: true, mode: 0o700 }).catch(cause => { throw appError('STORAGE_ERROR', { cause }); });

    /**
     * @param {string} id @param {string|undefined} threadId
     * @param {(session:Conversation, role:CharacterRecord, threadId:string, agent:AgentService, history:TimelineReader, changes:ArchiveChanges) => unknown} change
     * @param {AbortSignal} [signal] @returns {Promise<ThreadView>}
     */
    async function update(id, threadId, change, signal) {
        assertConnected(signal);
        const key = normalizeCharacterId(id);
        const store = kernel.inject('storage');
        const threadKey = threadId === undefined
            ? await firstThreadId(store, await store.characters.get(key))
            : normalizeThreadId(threadId);
        const release = await locks.acquire(threadKey);
        try {
            const role = await store.characters.get(key);
            const agent = kernel.inject('agent');
            const record = selectAgent(structuredClone(await loadThread(store, role, threadKey)), agent.id);
            const history = timelineReader(store.archive, { roleId: key, threadId: threadKey, provider: agent.id }, record);
            /** @type {ArchiveChanges} */
            const changes = {};
            assertConnected(signal);
            await change(record, role, threadKey, agent, history, changes);
            assertConnected(signal);
            record.updatedAt = new Date().toISOString();
            record.revisionId = randomUUID();
            const saved = threadKey === key
                ? await store.characters.save(/** @type {CharacterRecord} */ (record), signal, changes)
                : await store.threads.save(key, /** @type {ThreadRecord} */ (record), signal, changes);
            return threadView(role, saved || record, threadKey);
        } finally {
            await release();
        }
    }

    /**
     * @param {string} id @param {string|undefined} threadId @param {unknown} body
     * @param {AbortSignal} [signal] @param {StreamOptions} [stream] @param {boolean} [replace]
     */
    async function send(id, threadId, body, signal, stream, replace = false) {
        const fields = recordInput(body);
        const inputText = replace ? '' : field(fields.message, '消息', LIMITS.messageLength, true);
        const record = await update(id, threadId, async (session, role, threadKey, agent, history, changes) => {
            checkRevision(session, fields.revision, replace);
            let message = inputText;
            if (replace) message = await rewindForRegeneration(session, history, changes);
            const { id: characterId, name, description, greeting } = role;
            const { sessionId } = session;
            const env = {
                characterId, threadId: threadKey, character: { name, description, greeting }, message, sessionId, signal,
                stateless: agent.stateless === true,
            };

            stream?.onStart();
            const context = await kernel.collectContext(env);
            assertConnected(signal);
            /** @type {AgentRequest} */
            const input = {
                cwd, character: env.character, message, sessionId, signal,
                history: structuredClone(session.messages.slice(-LIMITS.historyMessages)), context,
            };
            const result = await runTurn(agent.run, input, stream && (text => {
                stream.onDelta(text);
                void kernel.emit('onDelta', { characterId, threadId: threadKey, text });
            }));
            assertConnected(signal);
            assertReply(result, sessionId);
            session.sessionId = result.sessionId;
            session.messages.push({ role: 'user', text: message }, { role: 'assistant', text: result.reply });
        }, signal);
        void kernel.emit('afterTurn', { characterId: record.id, threadId: record.threadId, sessionId: record.sessionId });
        return record;
    }

    /** @param {string} id @param {string} [threadId] */
    async function snapshot(id, threadId) {
        const store = kernel.inject('storage');
        const role = await store.characters.get(normalizeCharacterId(id));
        const key = threadId === undefined ? await firstThreadId(store, role) : normalizeThreadId(threadId);
        const loaded = await loadThread(store, role, key);
        const provider = kernel.inject('agent').id;
        const record = provider === loaded.provider ? loaded : selectAgent(structuredClone(loaded), provider);
        return { role, key, record, store };
    }

    /** @param {string} id @param {string} [threadId] @returns {Promise<ThreadView>} */
    async function get(id, threadId) {
        const { role, key, record } = await snapshot(id, threadId);
        return threadView(role, record, key);
    }

    /** @param {string} id @param {string} [threadId] @param {AbortSignal} [signal] */
    async function reset(id, threadId, signal) {
        const record = await update(id, threadId, (session, _role, _thread, _agent, _history, changes) => {
            changes.prune = !!session.archive?.length;
            delete session.archive;
            session.messages = [];
            session.sessionId = null;
        }, signal);
        void kernel.emit('onSessionReset', { characterId: record.id, threadId: record.threadId, sessionId: null });
        return record;
    }

    /** @template T @param {string} key @param {(role:CharacterRecord, store:StorageService) => Promise<T>} change @returns {Promise<T>} */
    async function withMembership(key, change) {
        const release = await membership.acquire(key);
        try {
            const store = kernel.inject('storage');
            return await change(await store.characters.get(key), store);
        } finally { await release(); }
    }

    return {
        listCharacters: async () => (await kernel.inject('storage').characters.list())
            .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        /** @param {unknown} body @returns {Promise<CharacterRecord>} */
        createCharacter: async body => {
            const store = kernel.inject('storage');
            const record = {
                id: randomUUID(), ...profile(body), messages: [], sessionId: null,
                provider: kernel.inject('agent').id, inactiveSessions: {}, revisionId: randomUUID(), updatedAt: new Date().toISOString(),
            };
            await store.characters.save(record);
            return record;
        },
        getCharacter: get,
        /** @param {string} id @param {unknown} body */
        editCharacter: async (id, body) => {
            const key = normalizeCharacterId(id);
            const fields = profile(body);
            const release = await locks.acquire(key);
            try {
                const { characters } = kernel.inject('storage');
                const record = await characters.get(key);
                await characters.save({ ...record, ...fields, updatedAt: new Date().toISOString() });
            } finally { await release(); }
            return get(key);
        },
        /** @param {string} id */
        deleteCharacter: async id => withMembership(normalizeCharacterId(id), async (role, store) => {
            const ids = (await extraThreads(store, role.id)).map(thread => thread.id);
            /** @type {import('./character-lock.js').ReleaseLock[]} */
            const held = [];
            try {
                // Order is fixed: membership, role/default, then extra threads. Never wait while holding a lock.
                for (const key of [role.id, ...ids]) held.push(await locks.acquire(key));
                await store.characters.delete(role.id);
                // Removing the role commits deletion. Unreachable files may remain only on cleanup failure.
                await Promise.allSettled(ids.map(key => store.threads.delete(role.id, key)));
            } finally {
                await Promise.all(held.map(release => release()));
            }
        }),
        /** @param {string} id @returns {Promise<ThreadSummary[]>} */
        listThreads: async id => {
            const store = kernel.inject('storage');
            const role = await store.characters.get(normalizeCharacterId(id));
            const provider = kernel.inject('agent').id;
            const extra = (await extraThreads(store, role.id)).map(thread => summarizeThread(thread, provider, thread.name));
            return role.defaultThreadDeleted ? extra : [summarizeThread(role, provider, defaultThreadName), ...extra];
        },
        /** @param {string} id @param {unknown} body @returns {Promise<ThreadSummary>} */
        createThread: async (id, body) => {
            const name = field(recordInput(body).name, '剧情线名称', LIMITS.threadNameLength, true);
            /** @type {ThreadSummary} */
            const summary = await withMembership(normalizeCharacterId(id), async (role, store) => {
                if (!store.threads) throw appError('THREADS_UNAVAILABLE');
                const count = (await extraThreads(store, role.id)).length + (role.defaultThreadDeleted ? 0 : 1);
                if (count >= LIMITS.threadsPerCharacter) throw appError('THREAD_LIMIT');
                const now = new Date().toISOString();
                /** @type {ThreadRecord} */
                const record = {
                    id: randomUUID(), name, createdAt: now, updatedAt: now, sessionId: null, messages: [],
                    provider: kernel.inject('agent').id, inactiveSessions: {}, revisionId: randomUUID(),
                };
                await store.threads.save(role.id, record);
                return summarizeThread(record, record.provider, name);
            });
            return summary;
        },
        getThread: get,
        /** @param {string} id @param {string} threadId */
        deleteThread: async (id, threadId) => {
            const target = normalizeThreadId(threadId);
            await withMembership(normalizeCharacterId(id), async (role, store) => {
                const extra = await extraThreads(store, role.id);
                const ids = [...(role.defaultThreadDeleted ? [] : [role.id]), ...extra.map(thread => thread.id)];
                if (!ids.includes(target)) throw appError('THREAD_NOT_FOUND');
                const release = await locks.acquire(target);
                try {
                    if (ids.length === 1) throw appError('LAST_THREAD');
                    if (target !== role.id) await store.threads.delete(role.id, target);
                    else {
                        const current = await store.characters.get(role.id);
                        // Keep the profile and unknown legacy data while retiring the old default forever.
                        await store.characters.save({
                            ...current, defaultThreadDeleted: true, sessionId: null, messages: [], archive: undefined, inactiveSessions: {},
                            revisionId: randomUUID(), updatedAt: new Date().toISOString(),
                        }, undefined, { prune: true });
                    }
                } finally { await release(); }
            });
        },
        /** @param {string} id @param {string} threadId @param {{before?:unknown,limit?:unknown}} opts @returns {Promise<MessagePage>} */
        messagePage: async (id, threadId, opts = {}) => {
            const limit = opts.limit === undefined ? LIMITS.messagePageSize : unsigned(opts.limit, '分页条数');
            if (limit < 1 || limit > LIMITS.messagePageMax) throw appError('INVALID_INPUT');
            const before = opts.before === undefined ? undefined : unsigned(opts.before, '分页位置');
            let missingRevision;
            for (let attempt = 0; attempt < 2; attempt++) {
                const { role, key, record, store } = await snapshot(id, threadId);
                const total = timelineCount(record);
                const end = Math.min(total, before ?? total);
                const start = Math.max(0, end - limit);
                const revision = threadRevision(record);
                if (missingRevision === revision) throw appError('STORAGE_ERROR');
                const history = timelineReader(store.archive, { roleId: role.id, threadId: key, provider: record.provider }, record);
                const messages = await history.range(start, end);
                if (messages) return { messages, start, total, revision };
                missingRevision = revision;
            }
            throw appError('THREAD_CHANGED');
        },
        /** @param {string} id @param {unknown} body @param {AbortSignal} [signal] */
        sendMessage: (id, body, signal) => send(id, undefined, body, signal),
        /** @param {string} id @param {unknown} body @param {StreamOptions} stream */
        sendMessageStream: (id, body, stream) => send(id, undefined, body, stream.signal, stream),
        /** @param {string} id @param {string} threadId @param {unknown} body @param {AbortSignal} [signal] @param {StreamOptions} [stream] */
        sendThreadMessage: (id, threadId, body, signal, stream) => send(id, threadId, body, signal, stream),
        /** @param {string} id @param {string} threadId @param {unknown} index @param {unknown} body @param {AbortSignal} [signal] */
        editMessage: (id, threadId, index, body, signal) => update(id, threadId, async (session, _role, _thread, _agent, history, changes) => {
            const fields = recordInput(body);
            checkRevision(session, fields.revision);
            const ordinal = messageIndex(session, index);
            const archived = archivedCount(session);
            if (ordinal >= archived) {
                const current = session.messages[ordinal - archived];
                current.text = editedText(current, fields.text);
            } else {
                const refs = session.archive ?? [];
                const shard = shardIndex(refs, ordinal);
                const messages = await history.readShard(shard);
                if (!messages) throw appError('STORAGE_ERROR');
                const offset = ordinal - (refs[shard - 1]?.end ?? 0);
                const current = messages[offset];
                changes.replace = {
                    id: refs[shard].id,
                    messages: messages.map((message, number) => number === offset ? { ...current, text: editedText(current, fields.text) } : message),
                };
            }
            session.sessionId = null;
        }, signal),
        /** @param {string} id @param {string} threadId @param {unknown} index @param {unknown} revision @param {AbortSignal} [signal] */
        truncateMessages: (id, threadId, index, revision, signal) => update(id, threadId, async (session, _role, _thread, _agent, history, changes) => {
            checkRevision(session, revision);
            await keepPrefix(session, messageIndex(session, index), history, changes);
            session.sessionId = null;
        }, signal),
        /** @param {string} id @param {string} threadId @param {unknown} body @param {AbortSignal} [signal] @param {StreamOptions} [stream] */
        regenerate: (id, threadId, body, signal, stream) => send(id, threadId, body, signal, stream, true),
        /** @param {string} id @param {AbortSignal} [signal] */
        resetSession: (id, signal) => reset(id, undefined, signal),
        /** @param {string} id @param {string} threadId @param {AbortSignal} [signal] */
        resetThread: (id, threadId, signal) => reset(id, threadId, signal),
    };
}

/** @param {StorageService} store @param {CharacterRecord} role @returns {Promise<string>} */
async function firstThreadId(store, role) {
    if (!role.defaultThreadDeleted) return role.id;
    const [first] = await extraThreads(store, role.id);
    if (!first) throw appError('THREAD_NOT_FOUND');
    return first.id;
}

/** @param {StorageService} store @param {string} id @returns {Promise<ThreadRecord[]>} */
async function extraThreads(store, id) {
    return (await store.threads?.list(id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** @param {StorageService} store @param {CharacterRecord} role @param {string} key @returns {Promise<CharacterRecord|ThreadRecord>} */
async function loadThread(store, role, key) {
    if (key === role.id && !role.defaultThreadDeleted) return role;
    if (!store.threads || key === role.id) throw appError('THREAD_NOT_FOUND');
    return store.threads.get(role.id, key);
}

/** @param {CharacterRecord} role @param {CharacterRecord|ThreadRecord} record @param {string} threadId @returns {ThreadView} */
function threadView(role, record, threadId) {
    const { provider, messages, sessionId, inactiveSessions, updatedAt } = record;
    return {
        id: role.id, name: role.name, description: role.description, greeting: role.greeting,
        threadId, threadName: threadId === role.id ? defaultThreadName : record.name,
        provider, messages, sessionId, inactiveSessions, updatedAt, revision: threadRevision(record), total: timelineCount(record),
    };
}

/** @param {CharacterRecord|ThreadRecord} record @param {string} provider @param {string} name @returns {ThreadSummary} */
function summarizeThread(record, provider, name) {
    const session = record.provider === provider ? record
        : (Object.hasOwn(record.inactiveSessions, provider) ? record.inactiveSessions[provider] : undefined);
    return { id: record.id, name, updatedAt: record.updatedAt, messageCount: session ? timelineCount(session) : 0 };
}

/** @template {Conversation} T @param {T} record @param {string} provider @returns {T} */
function selectAgent(record, provider) {
    if (provider === record.provider) return record;
    const previous = Object.hasOwn(record.inactiveSessions, provider) ? record.inactiveSessions[provider] : undefined;
    record.inactiveSessions[record.provider] = { sessionId: record.sessionId, messages: record.messages, archive: record.archive };
    delete record.inactiveSessions[provider];
    record.provider = provider;
    record.sessionId = previous?.sessionId ?? null;
    record.messages = previous?.messages ?? [];
    record.archive = previous?.archive;
    return record;
}

/** @param {Conversation} session */
function threadRevision(session) {
    // Adapter changes alter the visible timeline even without a disk write.
    return session.id + ':' + session.provider + ':' + (session.revisionId ?? 'legacy');
}

/** @param {Conversation} session @param {unknown} expected */
function checkRevision(session, expected, required = true) {
    if (!required && expected === undefined) return;
    if (typeof expected !== 'string' || expected.length === 0 || expected.length > 192) {
        throw appError('INVALID_INPUT', { message: '需要有效的会话版本。' });
    }
    if (expected !== threadRevision(session)) throw appError('THREAD_CHANGED');
}

/** @param {Conversation} session @param {unknown} value */
function messageIndex(session, value) {
    const index = unsigned(value, '消息位置');
    if (index >= timelineCount(session)) throw appError('MESSAGE_NOT_FOUND');
    return index;
}

/** @param {unknown} value @param {string} label */
function unsigned(value, label) {
    const result = typeof value === 'number' ? value
        : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw appError('INVALID_INPUT', { message: label + '必须为非负整数。' });
    }
    return result;
}

/**
 * When truncation reaches the archive, reconstruct only a bounded tail of the
 * retained prefix; old referenced shards stay immutable until main commit.
 * @param {Conversation} session @param {number} length @param {TimelineReader} history @param {ArchiveChanges} changes
 */
async function keepPrefix(session, length, history, changes) {
    const archived = archivedCount(session);
    if (!archived || length > archived) {
        session.messages.length = length - archived;
        return;
    }
    const refs = session.archive;
    const tail = LIMITS.historyMessages - LIMITS.historyShardMessages;
    const keep = shardIndex(refs, Math.max(0, length - tail));
    const start = refs[keep - 1]?.end ?? 0;
    const messages = await history.range(start, length);
    if (!messages) throw appError('STORAGE_ERROR');
    session.archive = refs.slice(0, keep);
    session.messages = messages;
    changes.prune = true;
}

/** @param {Message} message @param {unknown} value */
function editedText(message, value) {
    return field(value, '消息', message.role === 'user' ? LIMITS.messageLength : LIMITS.replyLength, true);
}

/** @param {Conversation} session @param {TimelineReader} history @param {ArchiveChanges} changes */
async function rewindForRegeneration(session, history, changes) {
    const total = timelineCount(session);
    const start = total - LIMITS.turnMessages;
    if (start < 0) throw appError('REGENERATE_UNAVAILABLE');
    const messages = await history.range(start, total);
    if (!messages) throw appError('STORAGE_ERROR');
    const [previous, last] = messages;
    if (last?.role !== 'assistant' || previous?.role !== 'user' || !previous.text.trim()
        || previous.text.length > LIMITS.messageLength) throw appError('REGENERATE_UNAVAILABLE');
    // This is only a private snapshot: an incomplete regenerate never deletes the old turn.
    await keepPrefix(session, start, history, changes);
    session.sessionId = null;
    return previous.text;
}

/** @param {import('./agents/adapter.js').AgentResult} result @param {string|null} sessionId */
function assertReply(result, sessionId) {
    if (typeof result?.reply !== 'string' || !result.reply.trim()
        || typeof result.sessionId !== 'string' || !result.sessionId.trim()
        || result.sessionId.length > LIMITS.sessionIdLength
        || (sessionId !== null && result.sessionId !== sessionId)) throw appError('AGENT_INVALID_RESULT');
    if (result.reply.length > LIMITS.replyLength) throw appError('AGENT_REPLY_TOO_LONG');
}

/** @param {unknown} input @returns {Record<string, unknown>} */
function recordInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return /** @type {Record<string, unknown>} */ (input);
}

/** @param {unknown} body */
function profile(body) {
    const fields = recordInput(body);
    return {
        name: field(fields.name, '角色名称', LIMITS.nameLength, true),
        description: field(fields.description, '角色设定', LIMITS.descriptionLength, true),
        greeting: field(fields.greeting, '开场白', LIMITS.greetingLength),
    };
}

/** @param {unknown} value @param {string} label @param {number} limit */
function field(value, label, limit, required = false) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') throw appError('INVALID_INPUT', { message: label + '必须是文本。' });
    const trimmed = value.trim();
    if (required && !trimmed) throw appError('INVALID_INPUT', { message: label + '不能为空。' });
    if (trimmed.length > limit) throw appError('INVALID_INPUT', { message: label + '不能超过 ' + limit + ' 个字符。' });
    return trimmed;
}

/** @param {AbortSignal} [signal] */
function assertConnected(signal) {
    if (signal?.aborted) throw appError('STREAM_ABORTED');
}

/** @param {AgentAdapter} agent @param {AgentRequest} input @param {(text:string)=>void} [onDelta] */
async function runTurn(agent, input, onDelta) {
    if (!onDelta) return agent(input);
    let received = 0;
    /** @param {string} text */
    const preview = text => {
        assertConnected(input.signal);
        if (typeof text !== 'string') throw appError('AGENT_PROTOCOL');
        received += text.length;
        if (received > LIMITS.replyLength) throw appError('AGENT_REPLY_TOO_LONG');
        if (text) onDelta(text);
    };
    if (agent.stream) return agent.stream({ ...input, onDelta: preview });
    const result = await agent(input);
    if (typeof result?.reply === 'string') preview(result.reply);
    return result;
}
