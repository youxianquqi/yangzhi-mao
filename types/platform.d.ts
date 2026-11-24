
/** Narrow Node 22 surface used by this project; keeps TypeScript the only development dependency. */
declare namespace NodeJS {
    interface ProcessEnv { [name: string]: string | undefined }
    interface ErrnoException extends Error { code?: string }
}
declare const process: {
    readonly env: NodeJS.ProcessEnv;
    readonly argv: string[];
    readonly platform: string;
    readonly pid: number;
    readonly execPath: string;
    exitCode?: number;
    kill(pid: number, signal?: number | string): boolean;
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};
interface NodeBuffer extends Uint8Array {
    toString(encoding?: string): string;
}
declare const Buffer: {
    alloc(bytes: number): NodeBuffer;
    byteLength(text: string): number;
    concat(buffers: readonly Uint8Array[]): NodeBuffer;
};
declare module 'node:crypto' { export function randomUUID(): string }
declare module 'node:os' { export function hostname(): string }
declare module 'node:path' {
    export const delimiter: string;
    export function resolve(...paths: string[]): string;
    export function join(...paths: string[]): string;
    export function relative(from: string, to: string): string;
    export function dirname(path: string): string;
    export function basename(path: string): string;
    export function extname(path: string): string;
    export function isAbsolute(path: string): boolean;
}
declare module 'node:url' {
    export function fileURLToPath(url: URL | string): string;
    export function pathToFileURL(path: string): URL;
}
declare module 'node:fs' { export function existsSync(path: string): boolean }
declare module 'node:fs/promises' {
    interface Metadata { size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
    interface File {
        read(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
        close(): Promise<void>;
    }
    export function mkdir(path: string, options: {recursive: true, mode: number}): Promise<string | undefined>;
    export function open(path: string, flags: string): Promise<File>;
    export function lstat(path: string): Promise<Metadata>;
    export function realpath(path: string): Promise<string>;
    export function readdir(path: string): Promise<string[]>;
    export function readFile(path: string, encoding: 'utf8'): Promise<string>;
    export function writeFile(path: string, data: string, options: {flag: string, mode: number, flush?: boolean, signal?: AbortSignal}): Promise<void>;
    export function rm(path: string, options: {force: boolean}): Promise<void>;
    export function rename(from: string, to: string): Promise<void>;
    export function link(from: string, to: string): Promise<void>;
    export function unlink(path: string): Promise<void>;
}
declare module 'node:child_process' {
    interface Readable { on(event: 'data', callback: (chunk: NodeBuffer) => void): void; destroy(): void }
    export interface ChildProcessWithoutNullStreams {
        readonly pid?: number;
        readonly exitCode: number | null;
        readonly signalCode: string | null;
        readonly stdout: Readable;
        readonly stderr: Readable;
        readonly stdin: {
            on(event: 'error', callback: (error: Error) => void): void;
            end(payload: string, encoding: string): void;
            destroy(): void;
        };
        once(event: 'error', callback: (error: NodeJS.ErrnoException) => void): void;
        once(event: 'close', callback: (code: number | null, signal: string | null) => void): void;
        kill(signal: string): boolean;
        unref(): void;
    }
    export function spawn(file: string, args: string[], options: {
        cwd: string; shell: false; windowsHide: true; detached: boolean; stdio: ['pipe','pipe','pipe'];
    }): ChildProcessWithoutNullStreams;
    export function execFile(file: string, args: string[], options: {
        shell: false; windowsHide: true; timeout: number;
    }, fn: (error: NodeJS.ErrnoException | null) => void): void;
}
