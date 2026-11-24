// Notes are scoped to a timeline. The original role-level data belongs to its default timeline.
import { appError } from '../../src/errors.js';

/** @typedef {import('../../src/kernel.js').PluginContext} PluginContext */
/** @typedef {{clues: string[], summary: string}} Notes */
const limits = Object.freeze({ maxClues: 24, maxClueLength: 240, maxSummaryLength: 2000 });

/** @param {PluginContext} ctx @param {unknown} [_config] @returns {void} */
export function apply(ctx, _config) {
    const notes = ctx.storage.namespace('story-clues');

    /** @param {string} id @returns {Promise<Notes>} */
    async function readRoleNotes(id) {
        const legacy = await ctx.migration.readCharacterField(id, 'notes');
        const saved = await notes.get(id);
        if (saved !== undefined) return normalizeNotes(saved, 'STORAGE_ERROR');
        try {
            return legacy === undefined ? emptyNotes() : normalizeNotes(legacy);
        } catch {
            return emptyNotes();
        }
    }

    /** @param {string} id @returns {Promise<Notes>} */
    async function readThreadNotes(id) {
        const saved = await notes.get('thread-' + id);
        return saved === undefined ? emptyNotes() : normalizeNotes(saved, 'STORAGE_ERROR');
    }

    // The legacy route is also the default timeline, whose ID equals the role ID.
    ctx.routes.register('GET', 'notes', ({ id }) => readRoleNotes(id));
    ctx.routes.register('PUT', 'notes', async ({ id, body, signal }) => {
        const value = normalizeNotes(body);
        await ctx.migration.readCharacterField(id, 'notes'); // Validate that this local role still exists.
        signal.throwIfAborted();
        await notes.set(id, value, signal);
        return value;
    });
    ctx.routes.register('GET', 'thread-notes', ({ id }) => readThreadNotes(id));
    ctx.routes.register('PUT', 'thread-notes', async ({ id, body, signal }) => {
        const value = normalizeNotes(body);
        const exists = await ctx.migration.hasTimeline(id);
        if (!exists) throw appError('THREAD_NOT_FOUND');
        signal.throwIfAborted();
        await notes.set('thread-' + id, value, signal);
        return value;
    });
    ctx.ui.registerSlot('sidebar', { tag: 'story-clues-panel', entry: 'sidebar.js', style: 'sidebar.css' });
    ctx.on('beforePrompt', async ({ characterId, threadId, sessionId, stateless, signal }) => {
        if (!stateless && sessionId !== null) return;
        const value = threadId && threadId !== characterId ? await readThreadNotes(threadId) : await readRoleNotes(characterId);
        signal?.throwIfAborted();
        if (value.clues.length || value.summary) return value;
    });
    // Owned hooks, routes and descriptors are revoked automatically; durable notes are not deleted.
}

/** @returns {Notes} */
function emptyNotes() {
    return { clues: [], summary: '' };
}

/** @param {unknown} value @param {'INVALID_INPUT'|'STORAGE_ERROR'} [code] @returns {Notes} */
function normalizeNotes(value, code = 'INVALID_INPUT') {
    const notes = /** @type {{clues?: unknown, summary?: unknown}|null} */ (value);
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)
        || Object.keys(notes).some(key => key !== 'clues' && key !== 'summary')
        || !Array.isArray(notes.clues) || notes.clues.length > limits.maxClues || typeof notes.summary !== 'string') {
        throw appError(code, { message: '笔记需要 summary 文本和 clues 数组（最多 24 条）。' });
    }
    const summary = notes.summary.trim();
    if (summary.length > limits.maxSummaryLength) throw appError(code, { message: '摘要最多 2000 个字符。' });
    const clues = notes.clues.map(clue => {
        const text = typeof clue === 'string' ? clue.trim() : '';
        if (!text || text.length > limits.maxClueLength || /[\r\n]/.test(text)) {
            throw appError(code, { message: '每条线索必须是非空的单行文本（最多 240 个字符）。' });
        }
        return text;
    });
    return { clues, summary };
}
