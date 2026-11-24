// Adds optional role-playing guidance without changing the core prompt rules or writing data.
// Persona remains untrusted scene data, separate from the plugin's fixed guidance.

/** @typedef {import('../../src/kernel.js').PluginContext} PluginContext */
/** @typedef {{userPersona?: string, replyGuidance?: string[]}} PromptAdvice */

const maxPersonaLength = 2000;
const noTakeoverAdvice = '只扮演你的角色，不代替用户说话、采取行动或决定其感受；把用户的下一步留给用户。';
const noRepetitionAdvice = '不要逐字复述用户的消息、上一条助手回复或已有台词；在承接剧情时给出新的进展。';
const optionNames = new Set(['persona', 'noTakeover', 'noRepetition']);

/**
 * @param {PluginContext} ctx
 * @param {Readonly<Record<string,unknown>>} config Local allowlist options.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
    const advice = buildAdvice(config);
    if (advice.userPersona || advice.replyGuidance) ctx.on('beforePrompt', () => advice);
}

/** @param {Readonly<Record<string,unknown>>} config @returns {PromptAdvice} */
function buildAdvice(config) {
    if (Object.keys(config).some(key => !optionNames.has(key))) throw new Error('未知的人设插件配置项。');
    const { persona = '', noTakeover = true, noRepetition = true } = config;
    if (typeof persona !== 'string' || persona.length > maxPersonaLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(persona)) {
        throw new Error('persona 须为不超过 2000 个字符的文本。');
    }
    if (typeof noTakeover !== 'boolean' || typeof noRepetition !== 'boolean') throw new Error('防抢台词和防复读须为布尔值。');
    const userPersona = persona.trim();
    const replyGuidance = [
        ...(noTakeover ? [noTakeoverAdvice] : []),
        ...(noRepetition ? [noRepetitionAdvice] : []),
    ];
    return { ...(userPersona ? { userPersona } : {}), ...(replyGuidance.length ? { replyGuidance } : {}) };
}
