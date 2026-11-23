const id = '71a595b0-8995-4ab2-9000-5a27d4c8dd95';
const args = process.argv.slice(2);
const resume = args.includes('resume');
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const emit = event => console.log(JSON.stringify(event));

if (!args.includes('read-only') || !args.includes('--json') || args.at(-1) !== '-'
    || (resume && args.at(-2) !== id) || !prompt.includes('小写')
    || (resume && !prompt.includes('密码是什么'))) {
    process.exitCode = 2;
} else {
    emit({ type: 'thread.started', thread_id: id });
    emit({ type: 'item.updated', item: { type: 'agent_message', text: '尚未完成的文本。' } });
    emit({ type: 'item.completed', item: { type: 'command_execution', text: '此工具输出不属于对话。' } });

    if (prompt.includes('模拟网络故障')) {
        emit({ type: 'item.completed', item: { type: 'agent_message', text: '失败前的草稿。' } });
        emit({ type: 'turn.failed', error: { message: 'network connection closed' } });
        process.exitCode = 1;
    } else if (prompt.includes('模拟中途结束')) {
        emit({ type: 'item.completed', item: { type: 'agent_message', text: '缺少完成事件的草稿。' } });
    } else {
        emit({ type: 'item.completed', item: { type: 'agent_message', text: resume ? '青竹。' : '我记住了。' } });
        emit({ type: 'item.completed', item: { type: 'reasoning', text: '此内容不应该成为回复。' } });
        emit({ type: 'turn.completed' });
    }
}
