// Verifies managed effects and allowlisting without a CLI or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.js';
import { loadEnabledPlugins } from '../src/plugin-loader.js';

const sig = new AbortController().signal;
const codex = { id: 'codex', run: async () => ({ reply: 'codex', sessionId: 'local' }) };
const alternate = { id: 'alternate', run: async () => ({ reply: 'alternate', sessionId: 'remote' }) };
const event = {
    characterId: 'role-id', character: { name: '角色', description: '设定', greeting: '' },
    sessionId: null, message: '私人消息', signal: sig,
};

test('初始化异常不发布任何效果；停用按逆序清理并恢复默认服务', async () => {
    const { kernel, events } = setup();
    const cleanups = [];
    const fields = manifest('sample-one', ['hooks', 'routes', 'provide:agent']);
    const failed = await kernel.register(fields, ctx => {
        ctx.provide('agent', alternate);
        ctx.on('beforePrompt', () => ({ text: 'not published' }));
        ctx.routes.register('GET', 'about', () => ({ active: true }));
        ctx.onDispose(() => { cleanups.push('rollback'); });
        throw new Error('private config token');
    });
    assert.equal(failed, false);
    assert.deepEqual(await kernel.collectContext(event), []);
    assert.deepEqual(await kernel.dispatchRoute('sample-one', 'about', 'GET', request()), { found: false });
    assert.equal(kernel.inject('agent'), codex);
    assert.deepEqual(cleanups, ['rollback']);
    assert.deepEqual(events, [{ event: 'plugin_failed', phase: 'initialize', code: 'APPLY_FAILED', pluginId: 'sample-one' }]);

    await kernel.register(fields, ctx => {
        ctx.provide('agent', alternate);
        ctx.onDispose(() => { cleanups.push('first'); });
        ctx.onDispose(() => { throw new Error('bad cleanup'); });
        return () => { cleanups.push('returned'); };
    });
    assert.equal(kernel.inject('agent'), alternate);
    assert.ok(await kernel.unregister('sample-one'));
    assert.deepEqual(cleanups, ['rollback', 'returned', 'first']);
    assert.equal(kernel.inject('agent'), codex);
    assert.equal(events.at(-1).code, 'CLEANUP_FAILED');
    assert.equal(await kernel.unregister('sample-one'), false);
});

test('钩子异常只能影响该钩子；输入为快照，贡献去引用并限制总体积', async () => {
    const { kernel, events } = setup();
    const contribution = { note: ['safe'] };
    await kernel.register(manifest('test-hooks', ['hooks']), ctx => {
        ctx.on('beforePrompt', input => { input.character.name = '污染'; });
        ctx.on('beforePrompt', () => 'x'.repeat(66 * 1024));
        ctx.on('beforePrompt', () => contribution);
        ctx.on('afterTurn', () => { throw new Error('secret'); });
    });
    const output = await kernel.collectContext(event);
    contribution.note.push('later');
    assert.deepEqual(output, [{ pluginId: 'test-hooks', data: { note: ['safe'] } }]);
    assert.equal(event.character.name, '角色');
    await kernel.emit('afterTurn', { characterId: 'role-id', sessionId: 'new' });
    assert.deepEqual(events.map(e => [e.phase, e.code]), [
        ['beforePrompt', 'HOOK_FAILED'], ['beforePrompt', 'HOOK_FAILED'], ['afterTurn', 'HOOK_FAILED'],
    ]);
    assert.ok(events.every(e => Object.keys(e).length === 4));
});

test('只允许访问自己的命名空间；停用中止活动路由并隐藏所有效果', async () => {
    const { kernel, store, events } = setup();
    let observedAbort;
    let notify;
    const entered = new Promise(resolve => { notify = resolve; });
    const data = manifest('owner-plugin', ['routes', 'storage']);
    const ok = await kernel.register(data, async ctx => {
        assert.throws(() => ctx.storage.namespace('foreign'), /Foreign plugin namespace/);
        assert.throws(() => ctx.inject('storage'), /permission missing/);
        assert.throws(() => ctx.inject('agent'), /permission missing/);
        assert.throws(() => ctx.on('onDelta', () => {}), /permission missing/);
        const scope = ctx.storage.namespace(data.id);
        await scope.set('test-key', { info: true });
        assert.deepEqual(await scope.get('test-key'), { info: true });
        ctx.routes.register('GET', 'test', ({ signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => {
                observedAbort = true;
                resolve({});
            });
            notify();
        }));
    });
    assert.equal(ok, true);
    assert.deepEqual(store.get('owner-plugin').get('test-key'), { info: true });
    const running = kernel.dispatchRoute('owner-plugin', 'test', 'GET', request());
    await entered;
    await kernel.unregister('owner-plugin');
    assert.equal(observedAbort, true);
    assert.deepEqual(await running, { found: false });
    assert.deepEqual(await kernel.dispatchRoute('owner-plugin', 'test', 'GET', request()), { found: false });
    assert.deepEqual(events, []);
});

test('磁盘加载只执行白名单条目；坏插件可观测；浏览器只可读取指定资源', async t => {
    const root = await mkdtemp(join(tmpdir(), 'write-plugin-kernel-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dataDir = join(root, 'data');
    const pluginsDir = join(root, 'plugins');
    await mkdir(dataDir);
    await mkdir(pluginsDir);
    await addPlugin(pluginsDir, manifest('disabled-plugin', []), 'throw new Error("must never import");');
    await addPlugin(pluginsDir, manifest('broken-plugin', []), 'export function apply() { throw new Error("private info"); }');
    const plugin = manifest('sample-ui', ['ui', 'routes'], ['sidebar']);
    await addPlugin(pluginsDir, plugin, [
        'export function apply(ctx) {',
        'ctx.ui.registerSlot("sidebar", {tag:"sample-ui-panel",entry:"browser.js",style:"panel.css"});',
        'ctx.routes.register("GET","status",()=>({enabled:true}));',
        '}',
    ].join('\n'));
    const dir = join(pluginsDir, 'sample-ui');
    await writeFile(join(dir, 'browser.js'), 'export {};');
    await writeFile(join(dir, 'panel.css'), ':host { display: block; }');
    await writeFile(join(dir, 'secret.txt'), 'private config');
    const extra = join(root, 'outside');
    await mkdir(extra);
    await addPlugin(root, manifest('outside', []), 'throw new Error("outside");');
    await symlink(extra, join(pluginsDir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const allowlist = join(dataDir, 'plugins.json');
    await writeFile(allowlist, JSON.stringify({ plugins: {
        'disabled-plugin': { enabled: false }, 'broken-plugin': { enabled: true }, 'sample-ui': { enabled: true },
        'outside': { enabled: true }, '../invalid': { enabled: true },
    } }));
    const { kernel, log, events } = setup();
    await loadEnabledPlugins(kernel, { dataDir, pluginsDir, log });
    assert.equal(kernel.inject('agent'), codex);
    assert.deepEqual(kernel.getSlots(), [{
        pluginId: plugin.id, slot: 'sidebar', tag: 'sample-ui-panel',
        entry: '/plugin-assets/sample-ui/browser.js', style: '/plugin-assets/sample-ui/panel.css',
    }]);
    assert.equal(await readFile(await kernel.asset(plugin.id, 'browser.js'), 'utf8'), 'export {};');
    assert.equal(await kernel.asset(plugin.id, 'secret.txt'), undefined);
    assert.equal(await kernel.asset(plugin.id, 'index.mjs'), undefined);
    assert.equal(await kernel.asset(plugin.id, '../data/plugins.json'), undefined);
    assert.deepEqual(await kernel.dispatchRoute(plugin.id, 'status', 'GET', request()), { found: true, data: { enabled: true } });
    assert.deepEqual(events.map(e => [e.phase, e.code, e.pluginId]), [
        ['allowlist', 'INVALID_PLUGIN_SETTING', undefined], ['initialize', 'APPLY_FAILED', 'broken-plugin'],
        ['load', 'PLUGIN_LOAD_FAILED', 'outside'],
    ]);
    await kernel.dispose();
    assert.deepEqual(kernel.getSlots(), []);
    assert.equal(await kernel.asset(plugin.id, 'browser.js'), undefined);
    assert.deepEqual(await kernel.dispatchRoute(plugin.id, 'status', 'GET', request()), { found: false });
});

test('白名单缺省及非法格式不中断核心服务', async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'write-plugin-config-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const { kernel, log, events } = setup();
    await loadEnabledPlugins(kernel, { dataDir, pluginsDir: dataDir, log });
    assert.deepEqual(events, []);
    await writeFile(join(dataDir, 'plugins.json'), 'not json');
    await loadEnabledPlugins(kernel, { dataDir, pluginsDir: dataDir, log });
    assert.deepEqual(events, [{ event: 'plugin_failed', phase: 'allowlist', code: 'INVALID_ALLOWLIST' }]);
    assert.equal(kernel.inject('agent'), codex);
});

test('较慢的 delta 钩子不会积压任务，也不影响其他插件', async () => {
    const { kernel, events } = setup();
    const slow = [];
    const fast = [];
    let resume;
    const hold = new Promise(resolve => { resume = resolve; });
    await kernel.register(manifest('slow-hooks', ['hooks']), ctx => {
        ctx.on('onDelta', async ({ text }) => {
            slow.push(text);
            await hold;
        });
    });
    await kernel.register(manifest('fast-hooks', ['hooks']), ctx => {
        ctx.on('onDelta', ({ text }) => { fast.push(text); });
    });
    const first = kernel.emit('onDelta', { characterId: 'role-id', text: 'a' });
    await kernel.emit('onDelta', { characterId: 'role-id', text: 'b' });
    assert.deepEqual(slow, ['a']);
    assert.deepEqual(fast, ['a', 'b']);
    resume();
    await first;
    await kernel.emit('onDelta', { characterId: 'role-id', text: 'c' });
    assert.deepEqual(slow, ['a', 'c']);
    assert.deepEqual(fast, ['a', 'b', 'c']);
    assert.deepEqual(events, []);
});

function manifest(id, permissions, slots = []) {
    return { id, name: id, version: '1.0.0', entry: 'index.mjs', slots, permissions };
}

function request() {
    return { id: 'role-id', body: undefined, signal: sig };
}

function setup() {
    const events = [];
    const store = new Map();
    const storage = {
        characters: {}, readLegacyField: async () => undefined, hasTimeline: async () => true,
        namespace(id) {
            if (!store.has(id)) store.set(id, new Map());
            const records = store.get(id);
            return {
                get: async key => records.get(key),
                set: async (key, value) => { records.set(key, value); },
                delete: async key => { records.delete(key); },
            };
        },
    };
    const log = e => events.push(e);
    const kernel = createKernel({ storage, agent: codex, log });
    return { kernel, events, log, store };
}

async function addPlugin(root, plugin, text) {
    const directory = join(root, plugin.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'plugin.json'), JSON.stringify(plugin));
    await writeFile(join(directory, plugin.entry), text);
}
