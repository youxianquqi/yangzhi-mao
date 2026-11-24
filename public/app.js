// Links the native chat shell to the same-origin HTTP API and generic plugin mounts.
// Rendering never interprets server or user text as markup.
import { discoverExtensions, hasExtensions, updateMessageActions, updateSidebar } from './extensions.js';
import { activateCharacter, createChatState, isNearChatEnd } from './state.js';
import { requestThreadTurn, withRequestId } from './stream.js';
import { applyThreadCommit, pageSize, prependPage, readMessagePage } from './thread-state.js';

/** @typedef {import('./state.js').Character} Character */
/** @typedef {import('./state.js').CharacterSummary} CharacterSummary */
/** @typedef {import('./state.js').CommittedTurn} CommittedTurn */
/** @typedef {import('./thread-state.js').ThreadSummary} ThreadSummary */
/** @typedef {import('./thread-state.js').MessagePage} MessagePage */
/** @typedef {import('./state.js').Message} Message */
/** @typedef {{row: HTMLElement, text: HTMLParagraphElement, actions: HTMLDivElement}} Bubble */
/** @typedef {{user: Bubble|null, assistant: Bubble, output: string, previous: HTMLElement|null}} PendingTurn */

const list = $('characters');
const transcript = $('transcript');
const scroller = $('chat-scroll');
const jumpLatest = control('jump-latest', HTMLButtonElement);
const stopReplyButton = control('stop', HTMLButtonElement);
const message = control('message', HTMLTextAreaElement);
const dialog = control('character-dialog', HTMLDialogElement);
const resetDialog = control('reset-dialog', HTMLDialogElement);
const profileForm = control('profile-form', HTMLFormElement);
const sendForm = control('send-form', HTMLFormElement);
const search = control('character-search', HTMLInputElement);
const extensionPanel = $('extension-sidebar');
const threadPicker = control('thread-select', HTMLSelectElement);
const threadDialog = control('thread-dialog', HTMLDialogElement);
const messageDialog = control('message-dialog', HTMLDialogElement);
const removeDialog = control('remove-dialog', HTMLDialogElement);
const threadName = control('thread-name', HTMLInputElement);
const editText = control('edit-text', HTMLTextAreaElement);
const olderControls = $('older-controls');
const buttonIds = [
    'save', 'cancel', 'close-profile', 'confirm-reset', 'cancel-reset', 'close-reset',
    'cancel-thread', 'save-thread', 'cancel-message', 'save-message', 'cancel-remove', 'confirm-remove',
];
const editLimits = Object.freeze({ user: 8000, assistant: 32_000 });
const charactersPath = '/characters';
const selectedCharacterKey = 'write.character';
const themeKey = 'write.theme';
const mobile = matchMedia('(max-width: 780px)');
const desktopExtensions = matchMedia('(min-width: 1081px)');
const avatarTones = ['', 'tone-violet', 'tone-mint', 'tone-pink'];

let state = createChatState();
/** @type {ThreadSummary[]} */
let threads = [];
/** @type {MessagePage|null} */
let page = null;
/** @type {Map<string, string>} */
const drafts = new Map();
/** @type {{index: number, revision: string}|null} */
let editingMessage = null;
/** @type {(() => Promise<void>)|null} */
let confirmOperation = null;
/** @type {string|null} */
let editingId = null;
let busy = false;
/** @type {{controller: AbortController, requestId: string|null}|null} */
let activeStream = null;
let drawerOpen = false;
let extensionsOpen = desktopExtensions.matches;

setTheme(readPreference(themeKey) === 'dark');
bindEvents();
renderPage();
void work(initialize);
void discoverExtensions(refreshExtensions).catch(() => {
    console.warn({ event: 'plugin_ui_registry_failed' });
});

async function initialize() {
    const characters = /** @type {CharacterSummary[]} */ (await api(charactersPath));
    state = createChatState(characters);
    const first = characters.find(character => character.id === readPreference(selectedCharacterKey)) ?? characters[0];
    if (first) await select(first.id);
    else renderPage();
}

function bindEvents() {
    $('create').addEventListener('click', () => openProfile(null));
    $('edit').addEventListener('click', () => openProfile(state.current));
    for (const id of ['cancel', 'close-profile']) $(id).addEventListener('click', () => dialog.close());
    for (const id of ['cancel-reset', 'close-reset']) $(id).addEventListener('click', () => resetDialog.close());
    for (const modal of [dialog, resetDialog, threadDialog, messageDialog, removeDialog]) modal.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    profileForm.addEventListener('submit', submitProfile);
    bindThreadControls();
    $('reset').addEventListener('click', () => { setStatus($('reset-error')); resetDialog.showModal(); });
    $('reset-form').addEventListener('submit', resetSession);
    search.addEventListener('input', () => { renderList(); controls(); });
    $('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));
    $('mobile-menu').addEventListener('click', () => setDrawer(!drawerOpen));
    $('drawer-backdrop').addEventListener('click', () => setDrawer(false, true));
    mobile.addEventListener('change', () => setDrawer(false));
    desktopExtensions.addEventListener('change', () => { extensionsOpen = desktopExtensions.matches; updatePanels(); });
    $('toggle-extensions').addEventListener('click', () => { extensionsOpen = !extensionsOpen; updatePanels(); });
    document.addEventListener('keydown', closeOnEscape);
    message.addEventListener('input', composerControls);
    message.addEventListener('keydown', composerKeys);
    sendForm.addEventListener('submit', sendMessage);
    stopReplyButton.addEventListener('click', stopReply);
    scroller.addEventListener('scroll', updateTimelineJump, { passive: true });
    jumpLatest.addEventListener('click', () => { scroller.focus({ preventScroll: true }); scrollToLatest(); });
    const observer = new ResizeObserver(updateTimelineJump);
    observer.observe(scroller);
    observer.observe(transcript);
}

function bindThreadControls() {
    threadPicker.addEventListener('change', () => {
        const id = state.current?.id;
        const threadId = threadPicker.value;
        if (id && threadId) void work(() => selectThread(id, threadId));
    });
    $('thread-create').addEventListener('click', () => {
        threadName.value = '';
        setStatus($('thread-error'));
        threadDialog.showModal();
        threadName.focus();
    });
    $('thread-form').addEventListener('submit', submitThread);
    $('thread-delete').addEventListener('click', confirmThreadDeletion);
    $('older').addEventListener('click', () => { void work(loadEarlier); });
    $('message-form').addEventListener('submit', submitMessageEdit);
    $('remove-form').addEventListener('submit', runRemoval);
    $('cancel-thread').addEventListener('click', () => threadDialog.close());
    $('cancel-message').addEventListener('click', () => messageDialog.close());
    $('cancel-remove').addEventListener('click', () => removeDialog.close());
}

/** @param {string} id @returns {HTMLElement} */
function $(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error('Missing chat shell element: ' + id);
    return node;
}

/** @template {HTMLElement} T @param {string} id @param {new (...args: never[]) => T} type @returns {T} */
function control(id, type) {
    const node = $(id);
    if (!(node instanceof type)) throw new Error('Incorrect chat shell element type: ' + id);
    return node;
}

/** @param {string} id */
function characterPath(id) {
    return charactersPath + '/' + encodeURIComponent(id);
}

/** @param {string} path @param {{method?: string, data?: unknown}} [options] @returns {Promise<unknown>} */
async function api(path, { method = 'GET', data } = {}) {
    let response;
    try {
        const options = data === undefined ? {} : {
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        };
        response = await fetch('/api' + path, { method, ...options });
    } catch {
        throw new Error('无法连接本地服务，请确认它仍在运行。');
    }
    if (response.status === 204) return null;
    const result = await response.json().catch(() => null);
    if (response.ok && result !== null) return result;
    const detail = result?.error ?? '本地服务没有返回有效响应。';
    const requestId = response.status >= 500 ? response.headers.get('X-Request-Id') : null;
    throw new Error(withRequestId(detail, requestId));
}

/** @param {HTMLElement} target @param {string} [text] @param {boolean} [error] */
function setStatus(target, text = '', error = false) {
    target.textContent = text;
    target.classList.toggle('error', error);
}

function controls() {
    const current = state.current;
    control('create', HTMLButtonElement).disabled = busy;
    control('edit', HTMLButtonElement).disabled = busy || !current;
    control('reset', HTMLButtonElement).disabled = busy || !(current?.sessionId || page?.total);
    threadPicker.disabled = busy || !current;
    threadPicker.value = current?.threadId ?? '';
    control('thread-create', HTMLButtonElement).disabled = busy || !current;
    control('thread-delete', HTMLButtonElement).disabled = busy || threads.length < 2;
    control('older', HTMLButtonElement).disabled = busy || !page?.start;
    updateMessageControls();
    composerControls();
    for (const id of buttonIds) {
        control(id, HTMLButtonElement).disabled = busy;
    }
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
}

function composerControls() {
    const current = state.current;
    const send = control('send', HTMLButtonElement);
    send.hidden = Boolean(activeStream);
    send.disabled = busy || !current || !message.value.trim();
    stopReplyButton.hidden = !activeStream;
    stopReplyButton.disabled = !activeStream || activeStream.controller.signal.aborted;
    message.disabled = busy || !current;
    $('message-count').textContent = message.value.length + ' / ' + message.maxLength;
}

/** @param {() => void|Promise<void>} task @param {HTMLElement} [target] */
async function work(task, target = $('status')) {
    if (busy) return;
    busy = true;
    setStatus(target);
    controls();
    try {
        await task();
    } catch (error) {
        setStatus(target, error instanceof Error ? error.message : '本地服务出错。', true);
    } finally {
        busy = false;
        controls();
    }
}

function renderPage() {
    renderList();
    renderThreadPicker();
    renderChat();
    updateSidebar(extensionPanel, state.current?.id ?? null, state.current?.threadId ?? null);
    updatePanels();
    controls();
}

function renderList() {
    const query = search.value.trim().toLowerCase();
    const matches = state.characters.filter(({ name }) => name.toLowerCase().includes(query));
    list.replaceChildren();
    if (!matches.length) list.append(element('p', 'empty-hint', query ? '找不到匹配的角色' : '还没有角色，先创建一位吧。'));
    for (const character of matches) list.append(contact(character));
}

/** @param {CharacterSummary} character */
function contact({ id, name }) {
    const selected = state.current?.id === id;
    const button = element('button', 'character-item' + (selected ? ' is-selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selected));
    const picture = element('span', 'avatar-wrap');
    picture.append(avatar(name, id), element('span', 'avatar-online-dot'));
    const meta = element('span', 'character-meta');
    meta.append(element('span', 'character-name', name));
    if (selected) meta.append(element('span', 'character-preview', ' · 当前对话'));
    button.append(picture, meta);
    button.addEventListener('click', () => {
        if (selected) setDrawer(false, true);
        else void work(() => select(id));
    });
    return button;
}

function renderThreadPicker() {
    threadPicker.replaceChildren();
    for (const { id, name } of threads) {
        const option = element('option', '', name);
        option.value = id;
        threadPicker.append(option);
    }
}

function renderChat() {
    const current = state.current;
    renderChatHeader();
    transcript.replaceChildren();
    if (!current || !page) {
        transcript.append(element('p', 'empty-hint', '新建或选择一个角色，开始对话。'));
        updateTimelineJump();
        return;
    }
    transcript.append(messageRows(current, page));
    scrollToLatest();
}

/** @param {Character} character @param {MessagePage} part */
function messageRows(character, part) {
    const rows = document.createDocumentFragment();
    if (part.start === 0 && character.greeting) rows.append(bubble(character, 'assistant', character.greeting).row);
    for (const [offset, item] of part.messages.entries()) {
        const index = part.start + offset;
        const view = bubble(character, item.role, item.text);
        showCommitted(view, character, item, index);
        rows.append(view.row);
    }
    return rows;
}

function renderChatHeader() {
    const current = state.current;
    $('title').textContent = current?.name ?? '角色对话';
    $('agent-name').hidden = !current?.provider;
    $('agent-name').textContent = current?.provider ?? '';
    $('subtitle').textContent = !current ? '请选择角色' : current.sessionId ? 'SESSION // 已连接' : 'SESSION // 新会话';
    $('turn-count').textContent = (page?.total ?? 0) + ' 条记录';
    $('header-avatar').className = avatarClasses(current?.id);
    $('header-avatar').textContent = initial(current?.name);
    $('conversation-tools').hidden = !current;
    $('dossier-description').textContent = current?.description ?? '';
    olderControls.hidden = !page?.start;
}

function refreshExtensions() {
    const current = state.current;
    updateSidebar(extensionPanel, current?.id ?? null, current?.threadId ?? null);
    updatePanels();
    if (!current || !page || !hasExtensions('message-actions')) return;
    mutateTimeline(() => {
        for (const container of transcript.querySelectorAll('div[data-message-index]')) {
            const node = /** @type {HTMLDivElement} */ (container);
            const index = Number(node.dataset.messageIndex);
            const item = page?.messages[index - page.start];
            if (item) attachActions(node, current, item, index);
        }
    });
}

/** @param {HTMLDivElement} container @param {Character} character @param {Message} item @param {number} index */
function attachActions(container, character, item, index) {
    container.dataset.messageIndex = String(index);
    updateMessageActions(container, character.id, { role: item.role, text: item.text, index }, character.threadId ?? null);
}

/** @param {Bubble} view @param {Character} character @param {Message} item @param {number} index */
function showCommitted(view, character, item, index) {
    view.text.textContent = item.text;
    view.row.classList.remove('is-pending');
    view.row.dataset.messageOrdinal = String(index);
    attachActions(view.actions, character, item, index);
    const tools = element('div', 'message-tools');
    tools.append(actionButton('编辑', '编辑第 ' + (index + 1) + ' 条消息', () => openMessageEdit(index)));
    tools.append(actionButton('回退', '从第 ' + (index + 1) + ' 条消息回退', () => confirmTruncation(index)));
    if (item.role === 'assistant') {
        const regenerate = actionButton('重抽', '重新生成最后回复', () => {
            if (canRegenerate(index)) void work(() => sendStreamingTurn(character, null));
        });
        regenerate.dataset.regenerate = String(index);
        regenerate.hidden = !canRegenerate(index);
        tools.append(regenerate);
    }
    view.actions.before(tools);
}

/** @param {string} text @param {string} accessibleName @param {() => void} run */
function actionButton(text, accessibleName, run) {
    const button = element('button', 'message-action-button', text);
    button.type = 'button';
    button.dataset.messageAction = '';
    button.setAttribute('aria-label', accessibleName);
    button.addEventListener('click', run);
    return button;
}

function updateMessageControls() {
    for (const button of transcript.querySelectorAll('button[data-message-action]')) {
        if (!(button instanceof HTMLButtonElement)) continue;
        button.disabled = busy;
        if (button.dataset.regenerate !== undefined) button.hidden = !canRegenerate(Number(button.dataset.regenerate));
    }
}

/** @param {number} index */
function canRegenerate(index) {
    return page?.total === index + 1
        && page.messages.at(-1)?.role === 'assistant' && page.messages.at(-2)?.role === 'user';
}

function scrollToLatest() {
    scroller.scrollTop = scroller.scrollHeight;
    updateTimelineJump();
}

function updateTimelineJump() {
    jumpLatest.hidden = !state.current || isNearChatEnd(scroller);
}

/** @param {() => void} mutate */
function mutateTimeline(mutate) {
    const followTail = isNearChatEnd(scroller);
    mutate();
    if (followTail) scrollToLatest();
    else updateTimelineJump();
}

/** @param {Character} character @param {Message['role']} role @param {string} text @param {boolean} [isPending] @returns {Bubble} */
function bubble(character, role, text, isPending = false) {
    const user = role === 'user';
    const row = element('article', 'message-row ' + (user ? 'is-user' : 'is-assistant') + (isPending ? ' is-pending' : ''));
    const label = user ? '你' : character.name;
    const content = element('div', 'message-content');
    const body = element('p', 'message-bubble', text);
    const actions = element('div', 'message-actions');
    content.append(element('div', 'message-sender', label), body, actions);
    row.append(avatar(label, user ? '' : character.id), content);
    return { row, text: body, actions };
}

function updatePanels() {
    const enabled = Boolean(state.current && hasExtensions('sidebar'));
    const visible = enabled && extensionsOpen;
    const toggle = $('toggle-extensions');
    extensionPanel.hidden = !visible;
    toggle.hidden = !enabled;
    toggle.classList.toggle('is-active', visible);
    toggle.setAttribute('aria-expanded', String(visible));
    $('sidebar').classList.toggle('is-mobile-open', drawerOpen);
    $('sidebar').inert = mobile.matches && !drawerOpen;
    $('drawer-backdrop').classList.toggle('is-open', drawerOpen);
    $('mobile-menu').setAttribute('aria-expanded', String(drawerOpen));
}

/** @param {boolean} open @param {boolean} [restoreFocus] */
function setDrawer(open, restoreFocus = false) {
    drawerOpen = open && mobile.matches;
    updatePanels();
    if (drawerOpen) search.focus();
    else if (restoreFocus && mobile.matches) $('mobile-menu').focus();
}

/** @param {KeyboardEvent} event */
function closeOnEscape(event) {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (drawerOpen) setDrawer(false, true);
    else if (extensionsOpen && !extensionPanel.hidden && !desktopExtensions.matches) {
        extensionsOpen = false;
        updatePanels();
        $('toggle-extensions').focus();
    }
}

/** @param {string} id */
function threadsPath(id) {
    return characterPath(id) + '/threads';
}

/** @param {string} id @param {string} threadId */
function threadPath(id, threadId) {
    return threadsPath(id) + '/' + encodeURIComponent(threadId);
}

/** @param {string} id @param {string} threadId @param {number} [before] */
function historyPath(id, threadId, before) {
    return threadPath(id, threadId) + '/messages?limit=' + pageSize + (before === undefined ? '' : '&before=' + before);
}

/** @param {string} id @param {boolean} [moveToTop] */
async function select(id, moveToTop = false) {
    const available = /** @type {ThreadSummary[]} */ (await api(threadsPath(id)));
    const threadId = preferredThread(id, available);
    if (!threadId) throw new Error('这个角色没有可用的剧情线。');
    await selectThread(id, threadId, available, moveToTop);
    setDrawer(false, drawerOpen);
}

/** @param {string} id @param {ThreadSummary[]} available */
function preferredThread(id, available) {
    const preferred = readPreference('write.thread.' + id);
    return available.find(thread => thread.id === preferred)?.id ?? available[0]?.id;
}

/** @param {string} id @param {string} threadId @param {ThreadSummary[]} [available] @param {boolean} [moveToTop] */
async function selectThread(id, threadId, available = threads, moveToTop = false) {
    rememberDraft();
    const { character, latest } = await readThread(id, threadId);
    if (state.current?.id !== id) control('dossier', HTMLDetailsElement).open = false;
    threads = available;
    page = latest;
    state = activateCharacter(state, character, moveToTop);
    message.value = drafts.get(draftKey(id, threadId)) ?? '';
    writePreference(selectedCharacterKey, id);
    writePreference('write.thread.' + id, threadId);
    renderPage();
}

/** @param {string} id @param {string} threadId */
async function readThread(id, threadId) {
    // A second local client may commit between the metadata and page reads.
    for (let attempt = 0; attempt < 2; ++attempt) {
        const [meta, slice] = await Promise.all([api(threadPath(id, threadId)), api(historyPath(id, threadId))]);
        const character = /** @type {Character} */ (meta);
        const latest = readMessagePage(slice);
        if (character?.id === id && character.threadId === threadId
            && character.revision === latest.revision && latest.start + latest.messages.length === latest.total) return { character, latest };
    }
    throw new Error('剧情线已改变。请重新选择或刷新。');
}

/** @param {string} id @param {string} threadId */
function draftKey(id, threadId) {
    return id + ':' + threadId;
}

function rememberDraft() {
    const current = state.current;
    if (!current?.threadId) return;
    const key = draftKey(current.id, current.threadId);
    if (message.value.trim()) drafts.set(key, message.value);
    else drafts.delete(key);
}

async function loadEarlier() {
    const current = state.current;
    const before = page;
    if (!current?.threadId || !before?.start) return;
    const earlier = readMessagePage(await api(historyPath(current.id, current.threadId, before.start)));
    const joined = prependPage(before, earlier);
    if (!joined) {
        await selectThread(current.id, current.threadId);
        setStatus($('status'), '剧情线在别处更新，已刷新记录。');
        return;
    }
    const scrollAnchor = scroller.scrollTop - scroller.scrollHeight;
    page = joined;
    transcript.prepend(messageRows(current, earlier));
    renderChatHeader();
    scroller.scrollTop = scroller.scrollHeight + scrollAnchor;
    updateTimelineJump();
}

/** @param {SubmitEvent} event */
function submitThread(event) {
    event.preventDefault();
    const current = state.current;
    if (!current) return;
    void work(async () => {
        const created = /** @type {ThreadSummary} */ (await api(threadsPath(current.id), {
            method: 'POST', data: { name: threadName.value },
        }));
        await selectThread(current.id, created.id, [...threads, created]);
        threadDialog.close();
        setStatus($('status'), '已新建剧情线。');
    }, $('thread-error'));
}

function confirmThreadDeletion() {
    const current = state.current;
    const threadId = current?.threadId;
    if (!current || !threadId || threads.length < 2) return;
    const name = threads.find(thread => thread.id === threadId)?.name ?? '当前剧情线';
    openRemoval('删除剧情线？', '将删除「' + name + '」及其聊天记录，不影响其他剧情线。', async () => {
        await api(threadPath(current.id, threadId), { method: 'DELETE' });
        const available = /** @type {ThreadSummary[]} */ (await api(threadsPath(current.id)));
        const next = preferredThread(current.id, available);
        if (!next) throw new Error('没有可用的剧情线，请刷新核对。');
        await selectThread(current.id, next, available);
        drafts.delete(draftKey(current.id, threadId));
        setStatus($('status'), '已删除剧情线。');
    });
}

/** @param {number} index */
function openMessageEdit(index) {
    const item = page?.messages[index - page.start];
    if (busy || !page || !item) return;
    editingMessage = { index, revision: page.revision };
    editText.maxLength = editLimits[item.role];
    editText.value = item.text;
    setStatus($('message-error'));
    messageDialog.showModal();
    editText.focus();
}

/** @param {SubmitEvent} event */
function submitMessageEdit(event) {
    event.preventDefault();
    const current = state.current;
    const editing = editingMessage;
    if (!current?.threadId || !editing) return;
    void work(async () => {
        await api(threadPath(current.id, current.threadId) + '/messages/' + editing.index, {
            method: 'PATCH', data: { text: editText.value, revision: editing.revision },
        });
        await selectThread(current.id, current.threadId);
        messageDialog.close();
        setStatus($('status'), '消息已编辑。下次回复将使用更新后的本地记录。');
    }, $('message-error'));
}

/** @param {number} index */
function confirmTruncation(index) {
    const current = state.current;
    const threadId = current?.threadId;
    if (busy || !current || !threadId || !page) return;
    const { revision } = page;
    openRemoval('回退剧情？', '将删除第 ' + (index + 1) + ' 条消息以及之后的记录。', async () => {
        await api(threadPath(current.id, threadId) + '/messages/' + index
            + '?revision=' + encodeURIComponent(revision), { method: 'DELETE' });
        await selectThread(current.id, threadId);
        setStatus($('status'), '剧情已回退。');
    });
}

/** @param {string} title @param {string} detail @param {() => Promise<void>} run */
function openRemoval(title, detail, run) {
    $('remove-title').textContent = title;
    $('remove-detail').textContent = detail;
    setStatus($('remove-error'));
    confirmOperation = run;
    removeDialog.showModal();
    $('cancel-remove').focus();
}

/** @param {SubmitEvent} event */
function runRemoval(event) {
    event.preventDefault();
    const run = confirmOperation;
    if (!run) return;
    void work(async () => {
        await run();
        removeDialog.close();
        confirmOperation = null;
    }, $('remove-error'));
}

/** @param {Character|null} character */
function openProfile(character) {
    editingId = character?.id ?? null;
    $('dialog-title').textContent = editingId ? '编辑角色' : '新建角色';
    /** @type {Array<'name'|'description'|'greeting'>} */
    const fields = ['name', 'description', 'greeting'];
    for (const name of fields) {
        const field = profileForm.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = character?.[name] ?? '';
    }
    setStatus($('dialog-error'));
    dialog.showModal();
}

/** @param {SubmitEvent} event */
function submitProfile(event) {
    event.preventDefault();
    const id = editingId;
    const data = Object.fromEntries(new FormData(profileForm));
    void work(async () => {
        const profile = /** @type {Character} */ (await api(id ? characterPath(id) : charactersPath, {
            method: id ? 'PUT' : 'POST', data,
        }));
        if (id && state.current?.threadId) await selectThread(id, state.current.threadId, threads, true);
        else await select(profile.id, true);
        dialog.close();
        setDrawer(false, drawerOpen);
    }, $('dialog-error'));
}

/** @param {Event} event */
function resetSession(event) {
    event.preventDefault();
    const current = state.current;
    if (!current?.threadId) return;
    void work(async () => {
        await api(threadPath(current.id, current.threadId) + '/session', { method: 'DELETE' });
        await selectThread(current.id, current.threadId, threads, true);
        resetDialog.close();
        setStatus($('status'), '已开始新会话。');
    }, $('reset-error'));
}

/** @param {KeyboardEvent} event */
function composerKeys(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!control('send', HTMLButtonElement).disabled) sendForm.requestSubmit();
}

/** @param {SubmitEvent} event */
function sendMessage(event) {
    event.preventDefault();
    const character = state.current;
    const text = message.value.trim();
    if (!character || !text || busy) return;
    void work(() => sendStreamingTurn(character, text)).then(() => {
        if ([document.body, stopReplyButton, $('send')].some(node => node === document.activeElement)) {
            message.focus({ preventScroll: true });
        }
    });
}

/** @param {Character} character @param {string|null} text Null regenerates the last reply. */
async function sendStreamingTurn(character, text) {
    const current = page;
    const threadId = character.threadId;
    if (!current || !threadId) return;
    const regenerate = text === null;
    const request = { controller: new AbortController(), requestId: /** @type {string|null} */ (null) };
    const view = appendPendingTurn(character, text);
    const route = '/api' + threadPath(character.id, threadId) + '/messages' + (regenerate ? '/regenerate' : '') + '/stream';
    activeStream = request;
    controls();
    setStatus($('status'), regenerate ? '正在重新生成回复…' : '等待回复…');
    let rendered = false;
    try {
        const turn = await requestThreadTurn(route, {
            revision: current.revision, ...(text === null ? {} : { message: text }),
        }, {
            threadId,
            mode: regenerate ? 'regenerate' : 'pair',
            signal: request.controller.signal,
            onRequestId: id => { request.requestId = id; },
            onDelta: delta => { if (!request.controller.signal.aborted) appendDelta(view, delta); },
        });
        activeStream = null;
        controls();
        const next = applyThreadCommit(current, turn, regenerate);
        if (!regenerate) {
            message.value = '';
            drafts.delete(draftKey(character.id, threadId));
        }
        if (!next || turn.provider !== character.provider) {
            await selectThread(character.id, threadId, threads, true);
        } else {
            page = next;
            const updated = { ...character, sessionId: turn.sessionId, revision: next.revision, updatedAt: turn.updatedAt };
            state = activateCharacter(state, updated, true);
            finishPendingTurn(view, updated, turn, regenerate ? current.total - 1 : current.total);
            renderList();
            renderChatHeader();
        }
        rendered = true;
        setStatus($('status'), regenerate ? '新回复已保存。' : '回复已保存。');
    } catch (error) {
        if (!request.controller.signal.aborted) throw error;
        setStatus($('status'), withRequestId(regenerate ? '已停止重抽，保留原回复。' : '已停止本轮，输入已保留。', request.requestId));
    } finally {
        activeStream = null;
        if (!rendered) mutateTimeline(() => {
            view.user?.row.remove();
            view.assistant.row.remove();
            if (view.previous) view.previous.hidden = false;
        });
    }
}

/** @param {Character} character @param {string|null} text @returns {PendingTurn} */
function appendPendingTurn(character, text) {
    const user = text === null ? null : bubble(character, 'user', text, true);
    const assistant = bubble(character, 'assistant', '等待回复…', true);
    const index = (page?.total ?? 0) - 1;
    const previous = text === null
        ? /** @type {HTMLElement|null} */ (transcript.querySelector('[data-message-ordinal="' + index + '"]')) : null;
    mutateTimeline(() => {
        if (previous) previous.hidden = true;
        if (user) transcript.append(user.row);
        transcript.append(assistant.row);
    });
    return { user, assistant, previous, output: '' };
}

/** @param {PendingTurn} view @param {string} delta */
function appendDelta(view, delta) {
    if (!view.output) setStatus($('status'), '正在接收回复…');
    view.output += delta;
    mutateTimeline(() => { view.assistant.text.textContent = view.output; });
}

/** @param {PendingTurn} view @param {Character} character @param {CommittedTurn} turn @param {number} index */
function finishPendingTurn(view, character, turn, index) {
    // Keep scroll anchoring and give plugins only committed messages.
    mutateTimeline(() => {
        view.previous?.remove();
        const bubbles = view.user ? [view.user, view.assistant] : [view.assistant];
        for (const [offset, row] of bubbles.entries()) showCommitted(row, character, turn.messages[offset], index + offset);
    });
}

function stopReply() {
    if (!activeStream || activeStream.controller.signal.aborted) return;
    activeStream.controller.abort();
    setStatus($('status'), '正在停止回复…');
    controls();
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} className @param {string} [text] @returns {HTMLElementTagNameMap[T]} */
function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** @param {string} [name] */
function initial(name) {
    return name ? Array.from(name)[0] : '猫';
}

/** @param {string} [id] */
function avatarClasses(id = '') {
    const index = (id.charCodeAt(0) || 0) % avatarTones.length;
    return ('avatar ' + avatarTones[index]).trimEnd();
}

/** @param {string} name @param {string} id */
function avatar(name, id) {
    const node = element('span', avatarClasses(id), initial(name));
    node.setAttribute('aria-hidden', 'true');
    return node;
}

/** @param {boolean} dark */
function setTheme(dark) {
    const theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    $('theme-toggle').setAttribute('aria-pressed', String(dark));
    $('theme-toggle').textContent = dark ? '☀' : '☾';
    writePreference(themeKey, theme);
}

/** @param {string} key */
function readPreference(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

/** @param {string} key @param {string} value */
function writePreference(key, value) {
    // Browser storage is optional; the backend remains authoritative for conversations.
    try { localStorage.setItem(key, value); } catch { /* Ephemeral preferences. */ }
}
