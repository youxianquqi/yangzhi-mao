import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKernel, parsePluginManifest } from '../src/kernel.js';
import { createPluginManager } from '../src/plugin-loader.js';

const fallback = { id: 'codex', run: async () => ({ reply: 'default', sessionId: 'default' }) };
const replacement = { id: 'local', run: async () => ({ reply: 'plugin', sessionId: 'local' }) };

test('hard boundaries cannot be hidden or overridden; service replacement must satisfy the contract', async () => {
    for (const slot of ['csp', 'host', 'origin', 'loopback', 'lock', 'atomicWrite', 'allowlist', 'safeMode']) {
        assert.equal(parsePluginManifest(manifest('denied', { hides: [slot] })), undefined);
        assert.equal(parsePluginManifest(manifest('denied', { overrides: [slot] })), undefined);
    }
    assert.equal(parsePluginManifest(manifest('denied', { hides: ['agent'] })), undefined);
    assert.equal(parsePluginManifest(manifest('denied', { hides: ['thread-selector'], permissions: [] })), undefined);
    assert.equal(parsePluginManifest(manifest('denied', { slots: ['main-view'] })), undefined);
    const { kernel, events } = setup();
    const provide = id => manifest(id, { overrides: ['agent'], permissions: ['provide:agent'] });
    assert.equal(await kernel.register(provide('empty-plugin'), ctx => ctx.provide('agent', null)), false);
    assert.equal(await kernel.register(provide('missing-plugin'), () => {}), false);
    assert.equal(await kernel.register(provide('first-plugin'), ctx => ctx.provide('agent', replacement)), true);
    assert.equal(await kernel.register(provide('second-plugin'), ctx => ctx.provide('agent', { ...replacement, id: 'second' })), true);
    assert.equal(kernel.inject('agent').id, 'second');
    assert.deepEqual(events.at(-1), {
        event: 'plugin_conflict', phase: 'slot', code: 'SLOT_CONFLICT', slot: 'agent',
        pluginId: 'second-plugin', previousPluginId: 'first-plugin',
    });
    const nextFallback = { ...fallback, id: 'deepseek' };
    kernel.setDefaultAgent(nextFallback);
    await kernel.unregister('second-plugin');
    assert.equal(kernel.inject('agent'), replacement);
    await kernel.unregister('first-plugin');
    assert.equal(kernel.inject('agent'), nextFallback);
});

test('web allowlist switches hot-register and dispose UI claims, preserving other settings', async t => {
    const { dataDir, pluginsDir } = await folders(t);
    const replace = manifest('story-clues', { slots: ['thread-selector'], overrides: ['thread-selector'] });
    await addPlugin(pluginsDir, replace, [
        'export function apply(ctx) {',
        '  ctx.ui.registerSlot("thread-selector", { tag: "story-clues-selector", entry: "replacement.js" });',
        '  ctx.onDispose(() => {});',
        '}',
    ].join('\n'));
    await writeFile(join(pluginsDir, 'story-clues', 'replacement.js'), 'export {};');
    const hide = manifest('persona-guard', { hides: ['thread-selector', 'main-view'] });
    await addPlugin(pluginsDir, hide, 'export function apply() {}');
    await addPlugin(pluginsDir, manifest('custom-plugin'), 'export function apply() {}');

    const { kernel, events, log } = setup();
    const plugins = createPluginManager(kernel, { dataDir, pluginsDir, log, safeMode: false });
    const original = { plugins: {
        'persona-guard': { enabled: false }, 'story-clues': { enabled: false, config: { kept: 'yes' } },
    } };
    await writeFile(join(dataDir, 'plugins.json'), JSON.stringify(original));
    await plugins.load();
    assert.deepEqual(kernel.getDefaultUi(), []);
    await assert.rejects(plugins.setEnabled('custom-plugin', true), { code: 'ROUTE_NOT_FOUND' });
    const first = await plugins.setEnabled('story-clues', true);
    assert.equal(first.state, 'active');
    assert.deepEqual(first.overrides, ['thread-selector']);
    assert.deepEqual(kernel.getDefaultUi(), [{ slot: 'thread-selector', pluginId: 'story-clues', action: 'override' }]);
    assert.deepEqual(kernel.getSlots().map(slot => slot.tag), ['story-clues-selector']);
    assert.deepEqual((await plugins.setEnabled('persona-guard', true)).hides, ['thread-selector', 'main-view']);
    assert.deepEqual(kernel.getDefaultUi().map(claim => [claim.slot, claim.action]), [
        ['thread-selector', 'hide'], ['main-view', 'hide'],
    ]);
    assert.deepEqual(kernel.getSlots(), []);
    assert.deepEqual(events.at(-1), {
        event: 'plugin_conflict', phase: 'slot', code: 'SLOT_CONFLICT', slot: 'thread-selector',
        pluginId: 'persona-guard', previousPluginId: 'story-clues',
    });
    const restarted = setup();
    await createPluginManager(restarted.kernel, { dataDir, pluginsDir, safeMode: false }).load();
    assert.deepEqual(restarted.kernel.getDefaultUi(), kernel.getDefaultUi());
    await restarted.kernel.dispose();
    await plugins.setEnabled('persona-guard', false);
    assert.deepEqual(kernel.getSlots().map(slot => slot.tag), ['story-clues-selector']);
    await plugins.setEnabled('story-clues', false);
    assert.deepEqual(kernel.getDefaultUi(), []);
    assert.deepEqual(kernel.getSlots(), []);
    assert.equal(await kernel.asset('story-clues', 'replacement.js'), undefined);
    const path = join(dataDir, 'plugins.json');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { plugins: {
        'story-clues': { enabled: false, config: { kept: 'yes' } },
        'persona-guard': { enabled: false },
    } });
    assert.deepEqual((await readdir(dataDir)).sort(), ['locks', 'plugins.json']);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('safe mode never evaluates entries and can disable a problematic custom plugin', async t => {
    const { dataDir, pluginsDir } = await folders(t);
    const marker = join(dataDir, 'entered');
    const writer = 'import { writeFile } from "node:fs/promises";' +
        'await writeFile(' + JSON.stringify(marker) + ', "unsafe"); export function apply() {}';
    await addPlugin(pluginsDir, manifest('custom-plugin', { hides: ['main-view'] }), writer);
    await addPlugin(pluginsDir, manifest('story-clues'), writer);
    const allowlist = join(dataDir, 'plugins.json');
    await writeFile(allowlist, JSON.stringify({ plugins: { 'custom-plugin': { enabled: true } } }));
    const old = process.env.SAFE_MODE;
    process.env.SAFE_MODE = '1';
    const { kernel, log } = setup();
    const plugins = createPluginManager(kernel, { dataDir, pluginsDir, log });
    if (old === undefined) delete process.env.SAFE_MODE;
    else process.env.SAFE_MODE = old;
    assert.equal(plugins.safeMode, true);
    await plugins.load();
    assert.equal(kernel.inject('agent'), fallback);
    assert.deepEqual(kernel.getDefaultUi(), []);
    const custom = (await plugins.list()).find(item => item.id === 'custom-plugin');
    assert.deepEqual(custom.hides, ['main-view']);
    assert.equal(custom.state, 'safe-mode');
    assert.equal(custom.builtIn, false);
    assert.equal(custom.toggleable, true);
    const disabled = await plugins.setEnabled('custom-plugin', false);
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.toggleable, false);
    assert.equal((await plugins.setEnabled('story-clues', true)).state, 'safe-mode');
    assert.equal(kernel.isActive('story-clues'), false);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    const parsed = JSON.parse(await readFile(allowlist, 'utf8'));
    assert.equal(parsed.plugins['custom-plugin'].enabled, false);
    assert.equal(parsed.plugins['story-clues'].enabled, true);
});

function setup() {
    const events = [];
    const log = entry => events.push(entry);
    const kernel = createKernel({ agent: fallback, storage: /** @type {any} */ ({}), log });
    return { kernel, log, events };
}

function manifest(id, options = {}) {
    return { id, name: id, version: '1.0.0', entry: 'index.mjs', slots: [], permissions: ['ui'], ...options };
}

async function folders(t) {
    const root = await mkdtemp(join(tmpdir(), 'write-plugin-boundaries-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const dataDir = join(root, 'data');
    const pluginsDir = join(root, 'plugins');
    await Promise.all([mkdir(dataDir), mkdir(pluginsDir)]);
    return { dataDir, pluginsDir };
}

async function addPlugin(root, plugin, text) {
    const directory = join(root, plugin.id);
    await mkdir(directory);
    await Promise.all([
        writeFile(join(directory, 'plugin.json'), JSON.stringify(plugin)),
        writeFile(join(directory, plugin.entry), text),
    ]);
}
