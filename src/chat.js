import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';
import { createCharacterStore, normalizeCharacterId } from './storage.js';

function field(value, label, limit, required = false) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') throw new AppError(400, 'INVALID_INPUT', label + '必须是文本。');
    const trimmed = value.trim();
    if (required && !trimmed) throw new AppError(400, 'INVALID_INPUT', label + '不能为空。');
    if (trimmed.length > limit) {
        throw new AppError(400, 'INVALID_INPUT', label + '不能超过 ' + limit + ' 个字符。');
    }
    return trimmed;
}

function profile(body) {
    return {
        name: field(body?.name, '角色名称', 50, true),
        description: field(body?.description, '角色设定', 4000, true),
        greeting: field(body?.greeting, '开场白', 1000),
    };
}

export async function createChatService({ dataDir, agent }) {
    const store = await createCharacterStore(dataDir);
    const agentDir = join(dataDir, 'agent-workspace');
    try {
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
    } catch (cause) {
        throw new AppError(500, 'STORAGE_ERROR', '无法创建 Codex 工作目录。', { cause });
    }
    const active = new Set();

    async function update(id, mutate) {
        const key = normalizeCharacterId(id);
        if (active.has(key)) {
            throw new AppError(409, 'CHARACTER_BUSY', '这个角色还有请求在处理，请稍等。');
        }
        active.add(key);
        try {
            const character = await store.get(key);
            await mutate(character);
            character.updatedAt = new Date().toISOString();
            await store.save(character);
            return character;
        } finally {
            active.delete(key);
        }
    }

    async function listCharacters() {
        const characters = await store.list();
        return characters
            .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async function createCharacter(body) {
        const character = {
            id: randomUUID(),
            ...profile(body),
            messages: [],
            sessionId: null,
            updatedAt: new Date().toISOString(),
        };
        await store.save(character);
        return character;
    }

    function editCharacter(id, body) {
        const fields = profile(body);
        return update(id, character => Object.assign(character, fields));
    }

    function sendMessage(id, body) {
        const message = field(body?.message, '消息', 8000, true);
        return update(id, async character => {
            const { name, description, greeting, sessionId } = character;
            const result = await agent({
                cwd: agentDir,
                character: { name, description, greeting },
                message,
                sessionId,
            });
            if (typeof result?.reply !== 'string' || !result.reply.trim()
                || typeof result.sessionId !== 'string' || !result.sessionId.trim()
                || (sessionId !== null && result.sessionId !== sessionId)) {
                throw new AppError(502, 'AGENT_INVALID_RESULT', 'Codex 未返回完整回复或返回了不同的会话。');
            }
            character.sessionId = result.sessionId;
            character.messages.push({ role: 'user', text: message }, { role: 'assistant', text: result.reply });
        });
    }

    function resetSession(id) {
        return update(id, character => {
            character.messages = [];
            character.sessionId = null;
        });
    }

    return { listCharacters, createCharacter, getCharacter: store.get, editCharacter, sendMessage, resetSession };
}
