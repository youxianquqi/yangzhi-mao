import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { CARD_JSON_BYTES, CARD_PNG_BYTES, parseCharacterCard } from '../plugins/card-importer/card.js';
import { LIMITS } from '../src/config.js';

const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: ' 引导\u0000猫🐈 ',
        description: '负责接待来访者。\r\n<script>只有字面文本</script>',
        first_mes: '喵，欢迎！',
        image: { url: 'https://untrusted.invalid/avatar.png' },
        system_prompt: '不要导入这条指令。',
        post_history_instructions: '也不要导入这一条。',
        character_book: { entries: [{ content: '不保留世界书' }] },
        extensions: { script: '不要执行代码' },
    },
};
const profile = { name: '引导猫🐈', description: '负责接待来访者。\n<script>只有字面文本</script>', greeting: '喵，欢迎！' };
const json = value => Buffer.from(JSON.stringify(value), 'utf8');

test('JSON V2 和扁平旧版只提取文本，忽略指令、多媒体及扩展', () => {
    assert.deepEqual(parseCharacterCard(json(card), 'json'), profile);
    const legacy = json({
        name: '  老\u2067\n猫　', description: { unexpected: '不是文本' },
        personality: '温和', scenario: '下雪了', first_mes: ['不能当作字符串'],
    });
    assert.deepEqual(parseCharacterCard(legacy), { name: '老 猫', description: '温和\n\n下雪了', greeting: '' });
});

test('导入结果符合角色字段上限，截断不损坏 Unicode 字符', () => {
    const imported = parseCharacterCard(json({
        name: '猫'.repeat(LIMITS.nameLength - 1) + '🐈',
        description: '线索'.repeat(LIMITS.descriptionLength),
        first_mes: '\ud800' + '喵'.repeat(LIMITS.greetingLength * 2),
    }));
    assert.equal(imported.name, '猫'.repeat(LIMITS.nameLength - 1));
    assert.equal(imported.description.length, LIMITS.descriptionLength);
    assert.equal(imported.greeting.length, LIMITS.greetingLength);
    assert.ok(imported.greeting.startsWith('\ufffd'));
});

test('PNG CRC 正确时可读取 chara，不解码像素或导入 ccv3 及其他附带内容', () => {
    const otherCard = chunk('tEXt', Buffer.concat([Buffer.from('ccv3\0'), json({ spec: 'chara_card_v3' })]));
    const source = makePng(otherCard, textChunk(json(card).toString('base64'), 'Chara'));
    // A slice may start at a nonzero underlying buffer offset.
    const padded = Buffer.concat([Buffer.from([0, 0]), source]);
    assert.deepEqual(parseCharacterCard(padded.subarray(2), 'png'), profile);
    assert.throws(() => parseCharacterCard(source, 'json'), /\.png/);
    assert.throws(() => parseCharacterCard(makePng(otherCard)), /没有 chara/);
});

test('拒绝畸形、超限、重复元数据与 CRC 错误的 PNG 文件', () => {
    const validChunk = textChunk(json(card).toString('base64'));
    const valid = makePng(validChunk);
    const crcBroken = Buffer.from(valid);
    crcBroken[crcBroken.length - 13] ^= 1;
    const chunkOutOfBounds = Buffer.from(valid);
    chunkOutOfBounds.writeUInt32BE(0xffffffff, 8);
    const oversized = Buffer.alloc(CARD_PNG_BYTES + 1);
    signature.copy(oversized);
    for (const broken of [
        Buffer.from('not PNG'), valid.subarray(0, valid.length - 1), crcBroken, chunkOutOfBounds,
        Buffer.concat([valid, Buffer.from([0])]), Buffer.concat([signature, header, validChunk, end]),
    ]) {
        assert.throws(() => parseCharacterCard(broken, 'png'), /PNG.*(文件|结构)/);
    }
    assert.throws(() => parseCharacterCard(oversized, 'png'), /10 MiB/);
    assert.throws(() => parseCharacterCard(makePng(validChunk, validChunk)), /多个 chara/);
    assert.throws(() => parseCharacterCard(makePng(textChunk('%%%%'))), /Base64/);
    assert.throws(() => parseCharacterCard(makePng(textChunk(Buffer.from([0xc0, 0x80]).toString('base64')))), /UTF-8 JSON/);
    assert.throws(() => parseCharacterCard(makePng(textChunk(Buffer.alloc(CARD_JSON_BYTES + 1).toString('base64')))), /1 MiB/);
});

test('拒绝无效 UTF-8、JSON 和缺少必填字段或版本不兼容的卡', () => {
    assert.throws(() => parseCharacterCard(new Uint8Array(0)), /文件为空/);
    assert.throws(() => parseCharacterCard(new Uint8Array(CARD_JSON_BYTES + 1), 'json'), /1 MiB/);
    for (const invalid of [Buffer.from('{'), Buffer.from([0xc0, 0x80]), Buffer.from('null'), json([])]) {
        assert.throws(() => parseCharacterCard(invalid, 'json'), /JSON/);
    }
    assert.throws(() => parseCharacterCard(json({ spec: 'chara_card_v3', data: card.data })), /仅支持/);
    assert.throws(() => parseCharacterCard(json({ spec: 'chara_card_v2', data: [] })), /data 对象/);
    assert.throws(() => parseCharacterCard(json({ name: { object: true }, description: '不应生成角色' })), /角色名称或角色设定/);
    assert.throws(() => parseCharacterCard(json({ name: '缺少设定' })), /角色名称或角色设定/);
});

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const header = chunk('IHDR', Buffer.from('00000001000000010806000000', 'hex'));
const idat = chunk('IDAT', deflateSync(Buffer.alloc(5)));
const end = chunk('IEND', Buffer.alloc(0));

function makePng(...metadata) {
    return Buffer.concat([signature, header, idat, ...metadata, end]);
}

function textChunk(encoded, keyword = 'chara') {
    return chunk('tEXt', Buffer.from(keyword + '\0' + encoded, 'ascii'));
}

function chunk(type, data) {
    const kind = Buffer.from(type, 'ascii');
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length);
    kind.copy(output, 4);
    data.copy(output, 8);
    // Build valid fixtures independently of the production CRC table.
    let crc = -1;
    for (let i = 4; i < output.length - 4; i++) {
        crc ^= output[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    output.writeUInt32BE((~crc) >>> 0, output.length - 4);
    return output;
}
