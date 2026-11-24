// Proves explicit startup activation, turn-scoped context and complete unload of the persona hook.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatService } from '../src/chat.js';
import { createKernel } from '../src/kernel.js';
import { loadEnabledPlugins } from '../src/plugin-loader.js';
import { createStorageService } from '../src/storage.js';

const id = 'persona-guard';
const pluginsDir = fileURLToPath(new URL('../plugins/', import.meta.url));
const character = { name: '门卫', description: '友善，但要调查旅人的来意。' };
const userPersona = '旅人\n"只身来到客栈" <script>';

test('人设插件仅按白名单注入当前回合；卸载后不再注入', async t => {
    const { kernel, chat, observed, configure } = await setup(t);
    const role = await chat.createCharacter(character);
    await configure({ enabled: false, config: { persona: userPersona } });
    await chat.sendMessage(role.id, { message: '我到了。' });
    assert.deepEqual(observed[0].context, []);

    await configure({ enabled: true, config: { persona: '  ' + userPersona + '  ' } });
    await chat.sendMessage(role.id, { message: '有人吗？' });
    assert.equal(observed[1].sessionId, 'offline-persona');
    const [{ pluginId, data }] = observed[1].context;
    assert.equal(pluginId, id);
    assert.equal(data.userPersona, userPersona);
    assert.equal(data.replyGuidance.length, 2);
    assert.match(data.replyGuidance[0], /不代替用户说话/);
    assert.match(data.replyGuidance[1], /不要逐字复述/);
    assert.deepEqual(await chat.getCharacter(role.id).then(data => data.description), character.description);

    assert.equal(await kernel.unregister(id), true);
    await chat.sendMessage(role.id, { message: '我再等等。' });
    assert.deepEqual(observed[2].context, []);
});

test('无效人设只隔离该插件；两个开关可以分别禁用且无须配置人设', async t => {
    const { chat, events, observed, configure } = await setup(t);
    const role = await chat.createCharacter(character);
    await configure({ enabled: true, config: { persona: 'X'.repeat(2001), noTakeover: 'private-test-secret' } });
    assert.deepEqual(events, [{ event: 'plugin_failed', phase: 'initialize', code: 'APPLY_FAILED', pluginId: id }]);
    await chat.sendMessage(role.id, { message: '你是谁？' });
    assert.deepEqual(observed.at(-1).context, []);

    await configure({ enabled: true, config: { noTakeover: false } });
    await chat.sendMessage(role.id, { message: '介绍一下。' });
    const [{ data }] = observed.at(-1).context;
    assert.equal(data.userPersona, undefined);
    assert.equal(data.replyGuidance.length, 1);
    assert.match(data.replyGuidance[0], /不要逐字复述/);
});

async function setup(t) {
    const events = [];
    const observed = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'write-persona-'));
    const log = event => events.push(event);
    const kernel = createKernel({
        log, storage: await createStorageService(dataDir),
        agent: {
            id: 'codex',
            run: async request => {
                observed.push(request);
                return { reply: '离线回复。', sessionId: 'offline-persona' };
            },
        },
    });
    t.after(async () => {
        await kernel.dispose();
        await rm(dataDir, { recursive: true, force: true });
    });
    const chat = await createChatService({ dataDir, kernel });
    return {
        kernel, chat, events, observed,
        async configure(config) {
            await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { [id]: config } }));
            await loadEnabledPlugins(kernel, { dataDir, pluginsDir, log });
        },
    };
}
