import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirs = new Set(['node_modules', 'data']);

function scriptsIn(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return ignoredDirs.has(entry.name) ? [] : scriptsIn(path);
        return entry.isFile() && /\.[cm]?js$/.test(entry.name) ? [path] : [];
    });
}

const scripts = scriptsIn(root).sort();
for (const script of scripts) {
    try {
        execFileSync(process.execPath, ['--check', script], { stdio: 'inherit' });
    } catch {
        console.error('Syntax check failed: ' + relative(root, script));
        process.exitCode = 1;
    }
}

if (!process.exitCode) console.log('Syntax checked ' + scripts.length + ' JavaScript files.');
