import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModelSettings } from '../src/model-settings.js';
import { contentType, delta, frame } from './fixtures/mock-openai.mjs';

test('模型设置保存独立私有文件，原子取消不改旧文件，重启时仍只报告脱敏尾号', async t => {
    const dataDir = await temporary(t);
    const models = await createModelSettings(dataDir, { env: {} });
    const initial = models.describe();
    assert.equal(initial.preset, 'deepseek');
    assert.equal(initial.configured, false);
    assert.deepEqual(initial.presets.map(preset => preset.id), ['deepseek', 'minimax']);
    assert.equal(models.getAgent().id, 'deepseek');
    await assert.rejects(models.getAgent().run({}), { code: 'AGENT_UNAVAILABLE' });
    const secret = 'local-key-9999';
    const saved = await models.save({ preset: 'deepseek', apiKey: secret });
    assert.equal(saved.apiKeyLast4, '9999');
    assert.equal(saved.apiKeySource, 'saved');
    assert.doesNotMatch(JSON.stringify(saved), /local-key/);
    const file = join(dataDir, 'secrets.json');
    const rawSaved = await readFile(file, 'utf8');
    assert.equal(JSON.parse(rawSaved).apiKey, secret);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const aborted = new AbortController();
    aborted.abort();
    const pinned = models.getAgent();
    await assert.rejects(models.save({ preset: 'minimax', apiKey: 'different-key' }, aborted.signal), { code: 'STREAM_ABORTED' });
    assert.equal(models.getAgent(), pinned);
    assert.equal(await readFile(file, 'utf8'), rawSaved);
    assert.ok((await readdir(dataDir)).every(name => !name.endsWith('.tmp')));
    assert.deepEqual((await createModelSettings(dataDir, { env: {} })).describe(), saved);
    await models.save({ preset: 'deepseek', apiKey: 'abcd' });
    assert.equal(models.describe().apiKeyConfigured, true);
    assert.equal(models.describe().apiKeyLast4, null);
    assert.doesNotMatch(JSON.stringify(models.describe()), /abcd/);
    await models.save({ preset: 'deepseek', apiKey: null });
    assert.equal(models.describe().apiKeyConfigured, false);
    assert.ok(!Object.hasOwn(JSON.parse(await readFile(file, 'utf8')), 'apiKey'));
});

test('环境密钥覆盖本地密钥但不传给自定义地址；已存密钥也不会自动转发', async t => {
    const dataDir = await temporary(t);
    const secret = 'environment-1111';
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        return completion();
    };
    const models = await createModelSettings(dataDir, { env: { DEEPSEEK_API_KEY: secret }, fetcher });
    await models.save({ preset: 'deepseek', apiKey: 'local-key-2222' });
    assert.equal(models.describe().apiKeySource, 'environment');
    assert.equal(models.describe().apiKeyLast4, '1111');
    assert.equal(JSON.parse(await readFile(join(dataDir, 'secrets.json'), 'utf8')).apiKey, 'local-key-2222');
    const pinned = models.getAgent();
    await pinned.run(request);
    assert.equal(calls.at(-1).init.headers.get('Authorization'), 'Bearer ' + secret);
    assert.equal(JSON.parse(calls.at(-1).init.body).thinking.type, 'disabled');
    assert.equal((await createModelSettings(dataDir, { env: {} })).describe().apiKeyLast4, '2222');

    await models.save({ preset: 'deepseek', baseUrl: 'http://localhost:5000/v1' });
    assert.equal(models.describe().configured, true);
    assert.equal(models.describe().apiKeyConfigured, false);
    assert.notEqual(models.getAgent(), pinned);
    await models.getAgent().run(request);
    assert.equal(calls.at(-1).url.href, 'http://127.0.0.1:5000/v1/chat/completions');
    assert.equal(calls.at(-1).init.headers.get('Authorization'), null);
    assert.ok(!Object.hasOwn(JSON.parse(calls.at(-1).init.body), 'thinking'));

    const onlyMinimax = await createModelSettings(await temporary(t), { env: { MINIMAX_API_KEY: 'mini-key-3333' } });
    assert.equal(onlyMinimax.describe().preset, 'minimax');
    assert.equal(onlyMinimax.describe().configured, true);
});

test('连接测试限于官方源与数字回环、不跟随跳转、不发送角色数据、不改磁盘', async t => {
    const dataDir = await temporary(t);
    const calls = [];
    const models = await createModelSettings(dataDir, {
        env: {},
        fetcher: async (url, init) => {
            calls.push({ url, init });
            return new Response(frame({ choices: [] }) + frame(delta('', 'length')), { headers: contentType });
        },
    });
    for (const baseUrl of ['https://api.deepseek.com.evil.invalid', 'https://api.deepseek.com:444', 'http://192.168.1.1', 'https://127.0.0.2']) {
        await assert.rejects(models.testConnection({ preset: 'deepseek', baseUrl, apiKey: 'test-key-5555' }), { code: 'INVALID_INPUT' });
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await models.testConnection({
        preset: 'minimax', baseUrl: 'https://api.minimax.io/v1', apiKey: 'test-key-5555',
    }), { ok: true });
    assert.deepEqual(await models.testConnection({ preset: 'deepseek', baseUrl: 'http://127.0.0.1:5000' }), { ok: true });
    const [{ url, init }, local] = calls;
    assert.equal(url.href, 'https://api.minimax.io/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.get('Authorization'), 'Bearer test-key-5555');
    const { max_tokens, messages } = JSON.parse(init.body);
    assert.equal(max_tokens, 16);
    assert.deepEqual(messages, [{ role: 'user', content: '回复 OK。' }]);
    assert.equal(local.init.headers.get('Authorization'), null);
    await assert.rejects(readFile(join(dataDir, 'secrets.json')), { code: 'ENOENT' });
});

const request = {
    cwd: '.', character: { name: '猫', description: '侦探', greeting: '' },
    message: '你好', sessionId: null,
};

function completion() {
    return new Response(frame(delta('你好', 'stop')) + frame('[DONE]'), { headers: contentType });
}

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'write-model-settings-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}
