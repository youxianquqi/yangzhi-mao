// All notes UI, drafts and requests belong to this plugin, not the core shell.
// An external Shadow DOM stylesheet inherits the host's theme tokens without relaxing CSP.

/** @typedef {{clues: string[], summary: string}} Notes */
/** @typedef {{cluesText: string, summary: string}} Draft */
/** @typedef {{saved: Map<string, Notes>, pending: Map<string, Draft>}} Drafts */

const route = '/api/plugins/story-clues/notes/';

/** @returns {Drafts} */
export function createDrafts() {
    return { saved: new Map(), pending: new Map() };
}

/** @param {Drafts} drafts @param {string} id @returns {{draft: Draft, dirty: boolean}} */
export function readDraft(drafts, id) {
    const baseline = drafts.saved.get(id) ?? { clues: [], summary: '' };
    const draft = drafts.pending.get(id) ?? { cluesText: baseline.clues.join('\n'), summary: baseline.summary };
    const value = notesFromDraft(draft);
    const dirty = value.summary !== baseline.summary || value.clues.length !== baseline.clues.length
        || value.clues.some((clue, i) => clue !== baseline.clues[i]);
    return { draft, dirty };
}

/** @param {Drafts} drafts @param {string} id @param {Notes} value @param {boolean} [acknowledged] */
export function receiveNotes(drafts, id, value, acknowledged = false) {
    drafts.saved.set(id, value);
    if (acknowledged) drafts.pending.delete(id);
}

/** @param {Draft} draft @returns {Notes} */
export function notesFromDraft({ cluesText, summary }) {
    return { clues: cluesText.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean), summary: summary.trim() };
}

if (typeof customElements !== 'undefined' && !customElements.get('story-clues-panel')) registerPanel();

function registerPanel() {
    class StoryCluesPanel extends HTMLElement {
        static observedAttributes = ['character-id'];

        #drafts = createDrafts();
        #summary = node('textarea', '', 'note-summary');
        #clues = node('textarea', '', 'note-clues');
        #cards = node('ul', '', 'clue-cards');
        #status = node('p', '', 'status');
        #save = node('button', '保存笔记', 'save-button');
        #retry = node('button', '重试', 'retry');
        /** @type {AbortController|null} */
        #request = null;
        #ready = false;

        constructor() {
            super();
            const root = this.attachShadow({ mode: 'open' });
            const css = node('link');
            css.rel = 'stylesheet';
            css.href = new URL('./sidebar.css', import.meta.url).href;
            const header = node('header', '', 'panel-header');
            header.append(node('h2', '剧情线索本'), node('span', 'CASE LOG', 'badge'));
            const form = node('form');
            this.#summary.rows = 4;
            this.#summary.placeholder = '记录当前阶段、人物关系或核心谜团…';
            this.#clues.rows = 3;
            this.#clues.placeholder = '记录证词、物证或疑点，每行一条…';
            this.#cards.setAttribute('aria-label', '当前线索');
            this.#status.setAttribute('role', 'status');
            this.#save.type = 'submit';
            this.#retry.type = 'button';
            this.#retry.hidden = true;
            this.#retry.addEventListener('click', () => { void this.#load(); });
            form.append(field('阶段摘要', this.#summary, '已保存的摘要与线索只用于新会话首轮。'),
                field('关键线索档案', this.#clues, '每行一条线索，空行会自动忽略。'),
                this.#cards, this.#save, this.#retry, this.#status);
            form.addEventListener('input', () => this.#recordDraft());
            form.addEventListener('submit', event => { event.preventDefault(); void this.#submit(); });
            root.append(css, header, form);
        }

        connectedCallback() { void this.#load(); }
        disconnectedCallback() {
            this.#request?.abort();
            this.#request = null;
            this.#ready = false;
        }
        attributeChangedCallback() { if (this.isConnected) void this.#load(); }

        async #load() {
            this.#request?.abort();
            this.#request = null;
            this.#ready = false;
            const id = this.getAttribute('character-id');
            this.#render(id);
            if (!id) return;
            const request = new AbortController();
            this.#request = request;
            this.#retry.hidden = true;
            this.#show('正在读取笔记…');
            try {
                const value = await fetchNotes(id, request.signal);
                if (request.signal.aborted) return;
                receiveNotes(this.#drafts, id, value);
                this.#ready = true;
                this.#show('');
            } catch (error) {
                if (request.signal.aborted) return;
                this.#retry.hidden = false;
                this.#show(error instanceof Error ? error.message : '无法读取笔记。', true);
            } finally {
                if (this.#request === request) {
                    this.#request = null;
                    this.#render(id);
                }
            }
        }

        #recordDraft() {
            const id = this.getAttribute('character-id');
            if (!id || !this.#ready || this.#request) return;
            this.#drafts.pending.set(id, { cluesText: this.#clues.value, summary: this.#summary.value });
            this.#show('');
            this.#updateCards(id);
        }

        async #submit() {
            const id = this.getAttribute('character-id');
            if (!id || !this.#ready || this.#request) return;
            const { draft, dirty } = readDraft(this.#drafts, id);
            if (!dirty) return;
            const request = new AbortController();
            this.#request = request;
            this.#updateCards(id);
            this.#show('正在保存…');
            try {
                const saved = await fetchNotes(id, request.signal, notesFromDraft(draft));
                if (request.signal.aborted) return;
                receiveNotes(this.#drafts, id, saved, true);
                this.#show('线索笔记已保存。');
            } catch (error) {
                if (!request.signal.aborted) this.#show(error instanceof Error ? error.message : '无法保存笔记。', true);
            } finally {
                if (this.#request === request) {
                    this.#request = null;
                    this.#render(id);
                }
            }
        }

        /** @param {string|null} id */
        #render(id) {
            const draft = id ? readDraft(this.#drafts, id).draft : { cluesText: '', summary: '' };
            this.#summary.value = draft.summary;
            this.#clues.value = draft.cluesText;
            this.#updateCards(id);
        }

        /** @param {string|null} id */
        #updateCards(id) {
            const { draft, dirty } = id ? readDraft(this.#drafts, id) : { draft: { cluesText: '', summary: '' }, dirty: false };
            const editable = this.#ready && !this.#request && Boolean(id);
            this.#summary.disabled = this.#clues.disabled = !editable;
            this.#save.disabled = !editable || !dirty;
            const { clues } = notesFromDraft(draft);
            this.#cards.replaceChildren(...clues.map(text => node('li', text)));
            if (!clues.length) this.#cards.append(node('li', '尚无线索', 'empty'));
        }

        /** @param {string} text @param {boolean} [error] */
        #show(text, error = false) {
            this.#status.textContent = text;
            this.#status.classList.toggle('error', error);
        }
    }
    customElements.define('story-clues-panel', StoryCluesPanel);
}

/** @param {string} id @param {AbortSignal} signal @param {Notes} [value] @returns {Promise<Notes>} */
async function fetchNotes(id, signal, value) {
    const response = await fetch(route + encodeURIComponent(id), {
        method: value ? 'PUT' : 'GET', signal,
        ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok || typeof data?.summary !== 'string' || !Array.isArray(data.clues)
        || !data.clues.every(/** @param {unknown} clue */ clue => typeof clue === 'string')) {
        const detail = typeof data?.error === 'string' ? data.error : '线索服务未返回有效结果。';
        throw new Error(typeof data?.requestId === 'string' ? detail + '（请求编号：' + data.requestId + '）' : detail);
    }
    return data;
}

/** @param {string} title @param {HTMLTextAreaElement} input @param {string} hint */
function field(title, input, hint) {
    const group = node('label', '', 'field');
    group.append(node('span', title, 'label'), input, node('small', hint));
    return group;
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} [text] @param {string} [className] @returns {HTMLElementTagNameMap[T]} */
function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
}
