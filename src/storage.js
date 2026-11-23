import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';

const characterIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function normalizeCharacterId(id) {
    if (typeof id !== 'string' || !characterIdPattern.test(id)) {
        throw new AppError(404, 'CHARACTER_NOT_FOUND', '找不到这个角色。');
    }
    return id.toLowerCase();
}

function storageError(cause) {
    return new AppError(500, 'STORAGE_ERROR', '无法读取或写入本地角色存档，请检查数据目录。', { cause });
}

function isRecord(record, id) {
    return record?.id === id
        && ['name', 'description', 'greeting', 'updatedAt'].every(key => typeof record[key] === 'string')
        && (record.sessionId === null || (typeof record.sessionId === 'string' && record.sessionId.trim() !== ''))
        && Array.isArray(record.messages)
        && record.messages.every(message => ['user', 'assistant'].includes(message?.role) && typeof message.text === 'string');
}

export async function createCharacterStore(dataDir) {
    const directory = join(dataDir, 'characters');
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
        throw storageError(error);
    }

    const recordPath = id => join(directory, id + '.json');

    async function get(id) {
        const key = normalizeCharacterId(id);
        try {
            const record = JSON.parse(await readFile(recordPath(key), 'utf8'));
            if (!isRecord(record, key)) throw new Error('Invalid character record');
            return record;
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new AppError(404, 'CHARACTER_NOT_FOUND', '找不到这个角色。');
            }
            throw storageError(error);
        }
    }

    async function list() {
        let files;
        try {
            files = await readdir(directory);
        } catch (error) {
            throw storageError(error);
        }
        return Promise.all(files
            .filter(name => name.endsWith('.json') && characterIdPattern.test(name.slice(0, -5)))
            .map(name => get(name.slice(0, -5))));
    }

    async function save(record) {
        const file = recordPath(normalizeCharacterId(record.id));
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', {
                flag: 'wx',
                mode: 0o600,
                flush: true,
            });
            await rename(temporary, file);
        } catch (error) {
            throw storageError(error);
        } finally {
            await rm(temporary, { force: true }).catch(() => {});
        }
    }

    return { get, list, save };
}
