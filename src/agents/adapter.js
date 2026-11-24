// Defines the protocol-neutral Agent slot; core does not interpret plugin prompt context.
// Deltas are temporary and only a completed result can establish persistence.

/** @typedef {{name: string, description: string, greeting: string}} CharacterProfile */
/** @typedef {import('../storage.js').Message} Message */
/** @typedef {import('../storage.js').JsonValue} JsonValue */
/** @typedef {{pluginId: string, data: JsonValue}} PromptContext */
/**
 * @typedef {object} AgentRequest
 * @property {string} cwd Isolated default CLI workspace.
 * @property {CharacterProfile} character Untrusted role data.
 * @property {string} message Untrusted text for this turn.
 * @property {string|null} sessionId Opaque session identifier scoped to the active adapter.
 * @property {readonly Message[]} [history] Committed prefix for stateless adapters and fresh CLI sessions.
 * @property {readonly PromptContext[]} [context] Isolated plugin context contributions.
 * @property {AbortSignal} [signal]
 */
/** @typedef {AgentRequest & {onDelta?: (text: string) => void}} StreamingAgentRequest */
/** @typedef {{reply: string, sessionId: string}} AgentResult */
/** @typedef {(request: AgentRequest) => Promise<AgentResult>} RunAgentTurn */
/** @typedef {(request: StreamingAgentRequest) => Promise<AgentResult>} StreamAgentTurn */
/** @typedef {RunAgentTurn & {stream?: StreamAgentTurn}} AgentAdapter */
/** @typedef {{id: string, run: AgentAdapter, stateless?: boolean}} AgentService */

export {};
