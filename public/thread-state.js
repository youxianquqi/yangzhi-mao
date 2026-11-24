// Keeps absolute history offsets stable across pagination, rendering and revision changes.
// A local view never merges data from different committed revisions.

/** @typedef {import('./state.js').Message} Message */
/** @typedef {import('./state.js').CommittedTurn} CommittedTurn */
/** @typedef {{messages: Message[], start: number, total: number, revision: string}} MessagePage */
/** @typedef {{id: string, name: string, updatedAt: string, messageCount: number}} ThreadSummary */

export const pageSize = 60;

/**
 * @param {unknown} value
 * @returns {MessagePage}
 */
export function readMessagePage(value) {
    const page = /** @type {Partial<MessagePage>|null} */ (value);
    if (!page || typeof page.start !== 'number' || !Number.isSafeInteger(page.start) || page.start < 0
        || typeof page.total !== 'number' || !Number.isSafeInteger(page.total) || page.total < page.start
        || !validRevision(page.revision) || !Array.isArray(page.messages)
        || page.messages.length > pageSize || page.start + page.messages.length > page.total
        || !page.messages.every(item => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string')) {
        throw new Error('本地服务返回了无效的消息分页。');
    }
    return /** @type {MessagePage} */ (page);
}

/** @param {unknown} value @returns {value is string} */
export function validRevision(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/**
 * @param {MessagePage} current
 * @param {MessagePage} earlier
 * @returns {MessagePage|null}
 */
export function prependPage(current, earlier) {
    if (earlier.revision !== current.revision || earlier.total !== current.total
        || earlier.start >= current.start || earlier.start + earlier.messages.length !== current.start) return null;
    return { ...current, start: earlier.start, messages: [...earlier.messages, ...current.messages] };
}

/**
 * @param {MessagePage} current
 * @param {CommittedTurn} turn
 * @param {boolean} regenerate
 * @returns {MessagePage|null}
 */
export function applyThreadCommit(current, turn, regenerate) {
    if (!validRevision(turn.revision) || turn.revision === current.revision
        || (regenerate && current.messages.at(-1)?.role !== 'assistant')
        || turn.total !== current.total + (regenerate ? 0 : turn.messages.length)) return null;
    const prefix = regenerate ? current.messages.slice(0, -1) : current.messages;
    return { ...current, total: turn.total, revision: turn.revision, messages: [...prefix, ...turn.messages] };
}
