// Shared private filesystem primitives; a rename is the only publication point.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AppError, appError } from './errors.js';

/** @param {string} dir Creates a private directory without accepting a symlink at its leaf. */
export async function privateDirectory(dir) {
    try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (!(await lstat(dir)).isDirectory()) throw new Error('Not a local directory');
    } catch (cause) {
        throw appError('STORAGE_ERROR', { cause });
    }
}

/** @param {string} file @param {number} [maxBytes] Reads only a regular file. */
export async function readJson(file, maxBytes = Infinity) {
    try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > maxBytes) throw appError('STORAGE_ERROR');
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (cause) {
        if (cause?.code === 'ENOENT') return undefined;
        throw cause;
    }
}

/** @param {string} file @param {string} text @param {AbortSignal} [signal] */
export async function atomicJson(file, text, signal) {
    if (signal?.aborted) throw appError('STREAM_ABORTED');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true, signal });
        // Rename is the commit point. A later close cannot undo a committed write.
        if (signal?.aborted) throw appError('STREAM_ABORTED');
        await rename(temporary, file);
    } catch (cause) {
        if (cause instanceof AppError) throw cause;
        if (cause?.name === 'AbortError' && signal?.aborted) throw appError('STREAM_ABORTED');
        throw appError('STORAGE_ERROR', { cause });
    } finally {
        await rm(temporary, { force: true }).catch(() => {});
    }
}
