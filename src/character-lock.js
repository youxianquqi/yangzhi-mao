// Coordinates local processes mutating the same role, independently of store and Agent I/O.
// Lock owners are immutable; an elapsed timeout never permits replacing a live owner.
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AppError, appError } from './errors.js';

const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const host = hostname();
const privateFile = { flag: 'wx', mode: 0o600 };
const maxPid = 2 ** 31 - 1;
const unknownOwnerMessage = '无法确认角色锁可安全恢复。请停止所有 Write 实例后检查锁文件。';

/** @typedef {{ host: string, pid: number, token: string }} LockOwner */
/** @typedef {() => Promise<void>} ReleaseLock */
/** @typedef {{ acquire: (id: string) => Promise<ReleaseLock> }} CharacterLock */

/**
 * Opens a per-role mutex namespace on a local filesystem supporting hard links.
 * @param {string} dataDir Same absolute data directory for every cooperating process.
 * @returns {Promise<CharacterLock>} Exclusive lock acquisition with an idempotent release callback.
 */
export async function createCharacterLock(dataDir) {
    const directory = join(dataDir, 'locks');
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (cause) {
        throw appError('STORAGE_ERROR', { cause });
    }
    return { acquire: id => acquire(directory, id) };
}

async function acquire(directory, id) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) throw appError('CHARACTER_NOT_FOUND');
    /** @type {LockOwner} */
    const owner = { host, pid: process.pid, token: randomUUID() };
    const lock = join(directory, id.toLowerCase() + '.lock');
    const candidate = lock + '.' + owner.token + '.tmp';
    let staged = false;
    try {
        await writeFile(candidate, JSON.stringify(owner), { ...privateFile, flush: true });
        staged = true;
        // Unlike an exclusive open followed by a write, a link never publishes half-written ownership.
        if (!await tryLink(candidate, lock)) await recoverAndClaim(candidate, lock);
    } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw appError('STORAGE_ERROR', { cause });
    } finally {
        if (staged) await unlink(candidate).catch(() => {});
    }

    let releasing;
    return () => releasing ??= release(lock, owner);
}

async function recoverAndClaim(candidate, lock) {
    const observed = await readOwner(lock);
    if (observed === null && await tryLink(candidate, lock)) return;
    if (!canProveDead(observed)) throw busy(observed);

    const guard = lock + '.reap';
    try {
        await writeFile(guard, '', privateFile);
    } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        throw busy(undefined);
    }

    try {
        const owner = await readOwner(lock);
        if (owner === null && await tryLink(candidate, lock)) return;
        if (!canProveDead(owner)) throw busy(owner);
        // An owner could release, be replaced, and exit while being checked. Confirm the token after
        // proving death. Only this reaper can unlink it now; normal writers never unlink others' locks.
        if ((await readOwner(lock))?.token !== owner.token) throw busy(owner);
        await unlink(lock);
        if (!await tryLink(candidate, lock)) throw appError('CHARACTER_BUSY');
    } finally {
        // If a reaper dies, normal acquisitions still work once the primary lock is absent.
        await unlink(guard).catch(() => {});
    }
}

async function tryLink(candidate, lock) {
    try {
        await link(candidate, lock);
        return true;
    } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        return false;
    }
}

/** Missing, uncertain, and confirmed-readable metadata must remain distinguishable. */
async function readOwner(lock) {
    try {
        const owner = JSON.parse(await readFile(lock, 'utf8'));
        if (typeof owner?.host !== 'string' || typeof owner.token !== 'string' || !uuidPattern.test(owner.token)
            || !Number.isInteger(owner.pid) || owner.pid < 1 || owner.pid > maxPid) return undefined;
        return owner;
    } catch (cause) {
        if (cause.code === 'ENOENT') return null;
        if (cause instanceof SyntaxError) return undefined;
        throw cause;
    }
}

function canProveDead(owner) {
    if (owner?.host !== host) return false;
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (cause) {
        // ESRCH is proof; EPERM, host mismatch and PID reuse must all fail closed.
        return cause.code === 'ESRCH';
    }
}

function busy(owner) {
    return owner === undefined || (owner && owner.host !== host)
        ? appError('CHARACTER_BUSY', { message: unknownOwnerMessage })
        : appError('CHARACTER_BUSY');
}

async function release(lock, owner) {
    try {
        if ((await readOwner(lock))?.token !== owner.token) throw new Error('Character lock ownership changed');
        await unlink(lock);
    } catch (cause) {
        throw appError('STORAGE_ERROR', { cause });
    }
}
