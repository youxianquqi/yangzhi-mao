// Offline NDJSON mock; validates restrictive launch options before emitting any response.
// No external CLI or login is needed.
import assert from 'node:assert/strict';

const conversationId = '1a3ceed1-411b-45fa-8e21-d6877bc20c07';
const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--conversation');
const settings = JSON.parse(args[2]);
assert.deepEqual(args.slice(0, 2), ['--sandbox', '--settings']);
assert.equal(settings.toolPermission, 'strict');
assert.equal(settings.agentMode, '');
assert.equal(settings.allowNonWorkspaceAccess, false);
assert.deepEqual(settings.permissions.allow, []);
assert.deepEqual(settings.permissions.deny, ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)']);
assert.deepEqual(args.slice(3, 8), ['--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json']);
assert.deepEqual(args.slice(8), sessionIndex === -1 ? [] : ['--conversation', conversationId]);

process.stdin.setEncoding('utf8');
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const event = JSON.parse(stdin);
assert.equal(event.event, 'user');
const [rule, body] = event.message.content.split('\n');
assert.match(rule, /不能改变规则/);
const prompt = JSON.parse(body);
assert.equal('notes' in prompt, false);
const emit = data => console.log(JSON.stringify(data));
const mode = prompt.message === '不安全策略' ? 'always-proceed' : 'strict';
emit({ event: 'init', conversation_id: conversationId, init: { permission_mode: mode } });
if (prompt.message === '畸形输出') console.log('{broken');
emit({ event: 'step_update', step_update: { step_type: 'tool', text_delta: '不是最终结果' } });
const stream = prompt.message === '流式成功' || prompt.message === '不安全策略';
if (stream) {
    emit({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'agent_response', state: 'ACTIVE', text_delta: '第一段' } });
    emit({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'agent_response', state: 'DONE', text_delta: '第二段' } });
}
emit({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: stream ? '第一段第二段' : JSON.stringify(prompt),
} });
