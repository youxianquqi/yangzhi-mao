const $ = id => document.getElementById(id);
const list = $('characters');
const transcript = $('transcript');
const message = $('message');
const dialog = $('character-dialog');
const profileForm = $('profile-form');
const sendForm = $('send-form');

let characters = [];
let current = null;
let editingId = null;
let busy = false;
let pending = '';

async function api(path = '', { method = 'GET', data } = {}) {
    let response;
    try {
        const options = data === undefined ? {} : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
        response = await fetch('/api/characters' + path, { method, ...options });
    } catch {
        throw new Error('无法连接本地服务，请确认它仍在运行。');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result === null) {
        const detail = result?.error ?? '本地服务没有返回有效响应。';
        const requestId = response.status >= 500 ? result?.requestId : null;
        throw new Error(requestId ? detail + '（请求编号：' + requestId + '）' : detail);
    }
    return result;
}

function status(text = '', error = false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', error);
}

function controls() {
    $('create').disabled = busy;
    $('role-actions').hidden = !current;
    $('edit').disabled = busy || !current;
    $('reset').disabled = busy || !current?.messages.length;
    $('send').disabled = busy || !current || !message.value.trim();
    $('save').disabled = busy;
    $('cancel').disabled = busy;
    message.disabled = busy || !current;
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
}

async function work(task, errorTarget = null) {
    if (busy) return;
    busy = true;
    status();
    if (errorTarget) errorTarget.textContent = '';
    controls();
    try {
        await task();
    } catch (error) {
        if (errorTarget) errorTarget.textContent = error.message;
        else status(error.message, true);
    } finally {
        busy = false;
        controls();
    }
}

function renderList() {
    list.replaceChildren();
    if (!characters.length) {
        const item = document.createElement('li');
        item.className = 'list-empty';
        item.textContent = '还没有角色';
        list.append(item);
    }
    for (const { id, name } of characters) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = name;
        button.setAttribute('aria-pressed', String(current?.id === id));
        button.addEventListener('click', () => {
            if (current?.id !== id) void work(() => select(id));
        });
        item.append(button);
        list.append(item);
    }
}

function bubble(role, text, isPending = false) {
    const article = document.createElement('article');
    article.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant') + (isPending ? ' pending' : '');
    const label = document.createElement('span');
    label.textContent = role === 'user' ? '你' : current.name;
    const content = document.createElement('p');
    content.textContent = text;
    article.append(label, content);
    return article;
}

function renderChat() {
    $('title').textContent = current?.name ?? '角色对话';
    $('subtitle').textContent = !current ? '选择一个角色，或新建一个。'
        : current.sessionId ? '继续上一次 Codex 会话' : '发送一条消息，开始 Codex 会话';
    transcript.replaceChildren();
    if (!current || (!current.messages.length && !current.greeting && !pending)) {
        const hint = document.createElement('p');
        hint.className = 'chat-empty';
        hint.textContent = current ? '还没有消息。跟这个角色打个招呼吧。' : '新建你的第一个角色，开始聊天。';
        transcript.append(hint);
    }
    if (current?.greeting) transcript.append(bubble('assistant', current.greeting));
    for (const { role, text } of current?.messages ?? []) transcript.append(bubble(role, text));
    if (pending) transcript.append(bubble('user', pending, true));
    transcript.scrollTop = transcript.scrollHeight;
}

function setCurrent(character) {
    current = character;
    if (character) localStorage.setItem('write.character', character.id);
    renderList();
    renderChat();
    controls();
}

function remember(character) {
    const { id, name, updatedAt } = character;
    characters = [{ id, name, updatedAt }, ...characters.filter(item => item.id !== id)];
    setCurrent(character);
}

async function select(id) {
    const character = await api('/' + id);
    message.value = '';
    setCurrent(character);
}

function openProfile(character) {
    editingId = character?.id ?? null;
    $('dialog-title').textContent = editingId ? '编辑角色' : '新建角色';
    profileForm.elements.name.value = character?.name ?? '';
    profileForm.elements.description.value = character?.description ?? '';
    profileForm.elements.greeting.value = character?.greeting ?? '';
    $('dialog-error').textContent = '';
    dialog.showModal();
}

$('create').addEventListener('click', () => openProfile(null));
$('edit').addEventListener('click', () => openProfile(current));
$('cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const id = editingId;
    const data = Object.fromEntries(new FormData(profileForm));
    void work(async () => {
        const character = await api(id ? '/' + id : '', { method: id ? 'PUT' : 'POST', data });
        if (!id) message.value = '';
        remember(character);
        dialog.close();
    }, $('dialog-error'));
});

$('reset').addEventListener('click', () => {
    if (!current || !window.confirm('开始新会话？此角色在本应用中的聊天记录会清空。')) return;
    void work(async () => {
        remember(await api('/' + current.id + '/session', { method: 'DELETE' }));
        status('已开始新会话。');
    });
});

message.addEventListener('input', controls);
sendForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = message.value.trim();
    if (!current || !text || busy) return;
    void work(async () => {
        pending = text;
        renderChat();
        status('等待 Codex 回复…');
        try {
            const character = await api('/' + current.id + '/messages', { method: 'POST', data: { message: text } });
            message.value = '';
            remember(character);
            status();
        } finally {
            pending = '';
            renderChat();
        }
    }).then(() => message.focus());
});

renderList();
renderChat();
void work(async () => {
    characters = await api();
    const previous = localStorage.getItem('write.character');
    const first = characters.find(character => character.id === previous) ?? characters[0];
    if (first) await select(first.id);
    else renderList();
});
