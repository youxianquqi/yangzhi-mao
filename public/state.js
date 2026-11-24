// Pure chat-shell state, with no knowledge of optional plugin features.

/** @typedef {{role: 'user'|'assistant', text: string}} Message */
/** @typedef {{id: string, name: string, updatedAt: string}} CharacterSummary */
/** @typedef {CharacterSummary & {description: string, greeting: string, sessionId: string|null, provider?: string, messages?: Message[], threadId?: string, threadName?: string, revision?: string}} Character */
/** @typedef {{characters: CharacterSummary[], current: Character|null}} ChatState */
/** @typedef {{sessionId: string, messages: Message[], updatedAt: string, provider?: string, threadId?: string, revision?: string, total?: number}} CommittedTurn */

const tailThresholdPx = 72;

/** @param {CharacterSummary[]} [characters] @returns {ChatState} */
export function createChatState(characters = []) {
    return { characters, current: null };
}

/** @param {ChatState} state @param {Character} character @param {boolean} [moveToTop] @returns {ChatState} */
export function activateCharacter(state, character, moveToTop = false) {
    if (!moveToTop) return { ...state, current: character };
    const { id, name, updatedAt } = character;
    const characters = [{ id, name, updatedAt }, ...state.characters.filter(item => item.id !== id)];
    return { characters, current: character };
}

/** @param {ChatState} state @param {string} id @param {CommittedTurn} turn @returns {ChatState} */
export function commitStreamTurn(state, id, turn) {
    const current = state.current;
    if (current?.id !== id || (turn.provider && current.provider && turn.provider !== current.provider)) return state;
    return activateCharacter(state, {
        ...current, sessionId: turn.sessionId, provider: turn.provider ?? current.provider,
        updatedAt: turn.updatedAt, messages: [...(current.messages ?? []), ...turn.messages],
    }, true);
}

/** @param {{scrollTop: number, scrollHeight: number, clientHeight: number}} viewport @returns {boolean} */
export function isNearChatEnd({ scrollTop, scrollHeight, clientHeight }) {
    return scrollHeight - scrollTop - clientHeight <= tailThresholdPx;
}
