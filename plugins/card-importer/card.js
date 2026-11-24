// The browser never decodes pixels, fetches image URLs, or uploads the original file.
export const CARD_JSON_BYTES = 1024 * 1024;
export const CARD_PNG_BYTES = 10 * 1024 * 1024;

// These limits mirror the public POST /api/characters contract.
const fieldLimits = { name: 50, description: 4000, greeting: 1000 };
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const maxChunks = 10_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
    for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0xedb88320 : 0);
    return byte;
});
const imageDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/** @typedef {{name:string,description:string,greeting:string}} Profile */
/** @typedef {'png'|'json'} Format */

/**
 * Reads Character Card V2/V3 or legacy SillyTavern JSON; never returns non-profile fields.
 * @param {Uint8Array} bytes
 * @param {Format} [format] Require the selected file type; otherwise use the PNG signature.
 * @returns {Profile}
 */
export function parseCharacterCard(bytes, format) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('角色卡文件为空。');
    const png = pngSignature.every((byte, index) => bytes[index] === byte);
    if (format === 'png' && !png) throw new Error('不是有效的 PNG 文件。');
    if (format === 'json' && png) throw new Error('此文件是 PNG，请使用 .png 文件名。');
    assertFileSize(bytes.byteLength, png ? 'png' : 'json');
    return extractProfile(readJson(png ? readCardChunk(bytes) : bytes));
}

/** @param {number} size @param {Format} format */
function assertFileSize(size, format) {
    if (size > (format === 'png' ? CARD_PNG_BYTES : CARD_JSON_BYTES)) {
        throw new Error(format === 'png' ? 'PNG 角色卡不能超过 10 MiB。' : 'JSON 角色卡不能超过 1 MiB。');
    }
}

/** @param {Uint8Array} bytes @returns {Uint8Array} */
function readCardChunk(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = pngSignature.length;
    let chunks = 0;
    let imageData = false;
    /** @type {Uint8Array|undefined} */
    let charaText;
    /** @type {Uint8Array|undefined} */
    let ccv3Text;
    while (offset + 12 <= bytes.length && ++chunks <= maxChunks) {
        const size = view.getUint32(offset);
        if (size > bytes.length - offset - 12) throw invalidPng();
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const start = offset + 8;
        const end = start + size;
        if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || chunkCrc(bytes, offset + 4, end) !== view.getUint32(end)) {
            throw invalidPng();
        }
        if (chunks === 1) {
            if (type !== 'IHDR' || size !== 13 || !validHeader(view, start)) throw invalidPng();
        } else if (type === 'IHDR') throw invalidPng();
        if (type === 'IDAT' && size) imageData = true;
        if (type === 'tEXt' && size >= 5) {
            if (size >= 6 && bytes[start + 5] === 0
                && String.fromCharCode(...bytes.subarray(start, start + 5)).toLowerCase() === 'chara') {
                if (charaText) throw new Error('PNG 含有多个 chara 角色卡字段。');
                charaText = bytes.subarray(start + 6, end);
            } else if (bytes[start + 4] === 0
                && String.fromCharCode(...bytes.subarray(start, start + 4)).toLowerCase() === 'ccv3') {
                if (ccv3Text) throw new Error('PNG 含有多个 ccv3 角色卡字段。');
                ccv3Text = bytes.subarray(start + 5, end);
            }
        }
        if (type === 'IEND') {
            if (size || end + 4 !== bytes.length || !imageData) throw invalidPng();
            const text = ccv3Text ?? charaText;
            const keyword = ccv3Text ? 'ccv3' : 'chara';
            if (!text) throw new Error('PNG 中没有 chara 或 ccv3 角色卡数据，请从原平台导出角色卡。');
            return decodeBase64(text, keyword);
        }
        offset = end + 4;
    }
    throw invalidPng();
}

/** @param {DataView} view @param {number} start */
function validHeader(view, start) {
    const width = view.getUint32(start);
    const height = view.getUint32(start + 4);
    return width > 0 && width <= 0x7fffffff && height > 0 && height <= 0x7fffffff
        && imageDepths.get(view.getUint8(start + 9))?.includes(view.getUint8(start + 8))
        && view.getUint8(start + 10) === 0 && view.getUint8(start + 11) === 0 && view.getUint8(start + 12) <= 1;
}

/** @param {Uint8Array} bytes @param {number} start @param {number} end */
function chunkCrc(bytes, start, end) {
    let crc = 0xffffffff;
    for (let index = start; index < end; index++) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function invalidPng() {
    return new Error('PNG 结构损坏或不完整。');
}

/** @param {Uint8Array} bytes @param {string} [keyword] @returns {Uint8Array} */
function decodeBase64(bytes, keyword = 'chara') {
    if (bytes.length > Math.ceil(CARD_JSON_BYTES / 3) * 4) throw new Error('PNG 内的角色卡数据不能超过 1 MiB。');
    const encoded = new TextDecoder().decode(bytes);
    let binary;
    try {
        if (encoded.length !== bytes.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
        binary = atob(encoded);
        if (btoa(binary) !== encoded) throw new Error();
    } catch {
        throw new Error('PNG 内的 ' + keyword + ' 字段不是有效的 Base64。');
    }
    if (binary.length > CARD_JSON_BYTES) throw new Error('PNG 内的角色卡数据不能超过 1 MiB。');
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** @param {Uint8Array} bytes @returns {unknown} */
function readJson(bytes) {
    try {
        return JSON.parse(utf8.decode(bytes));
    } catch {
        throw new Error('角色卡数据不是有效的 UTF-8 JSON。');
    }
}

/** @param {unknown} value @returns {Profile} */
function extractProfile(value) {
    if (!object(value)) throw new Error('角色卡 JSON 必须是对象。');
    let data = value;
    if (value.spec !== undefined) {
        const isV2 = value.spec === 'chara_card_v2'
            && (value.spec_version === undefined || (typeof value.spec_version === 'string' && /^2(?:\.\d+)*$/.test(value.spec_version)));
        const isV3 = value.spec === 'chara_card_v3'
            && (value.spec_version === undefined || (typeof value.spec_version === 'string' && /^3(?:\.\d+)*$/.test(value.spec_version)));
        if (!isV2 && !isV3) {
            throw new Error('仅支持 Character Card V2、V3 和旧版 SillyTavern 角色卡。');
        }
        if (!object(value.data)) {
            throw new Error((value.spec === 'chara_card_v3' ? 'Character Card V3' : 'Character Card V2') + ' 缺少有效的 data 对象。');
        }
        data = value.data;
    }
    const name = bounded(clean(data.name).replace(/\s+/g, ' '), fieldLimits.name);
    const description = bounded(clean(data.description) || [clean(data.personality), clean(data.scenario)].filter(Boolean).join('\n\n'),
        fieldLimits.description);
    const greeting = bounded(clean(data.first_mes), fieldLimits.greeting);
    if (!name || !description) throw new Error('角色卡缺少有效的角色名称或角色设定。');
    return { name, description, greeting };
}

/** @param {unknown} field */
function clean(field) {
    if (typeof field !== 'string') return '';
    return field.replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\ud800-\udfff]/gu, '\ufffd').trim();
}

/** @param {string} value @param {number} max */
function bounded(value, max) {
    // The server counts UTF-16 units; avoid splitting an emoji at the boundary.
    return value.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (typeof customElements !== 'undefined' && !customElements.get('card-importer-panel')) registerPanel();

function registerPanel() {
    class CardImporterPanel extends HTMLElement {
        #open = button('导入角色卡');
        #dialog = node('dialog');
        #file = node('input');
        #preview = node('dl');
        #status = node('p');
        #cancel = button('取消');
        #confirm = button('确认导入');
        #generation = 0;
        /** @type {Profile|null} */
        #profile = null;
        /** @type {AbortController|null} */
        #request = null;

        constructor() {
            super();
            const root = this.attachShadow({ mode: 'open' });
            const css = node('link');
            css.rel = 'stylesheet';
            css.href = new URL('./card.css', import.meta.url).href;
            const title = node('h2', '导入角色卡');
            title.id = 'card-title';
            this.#open.setAttribute('aria-haspopup', 'dialog');
            this.#dialog.setAttribute('aria-labelledby', title.id);
            const label = node('label', '选择角色卡文件');
            this.#file.type = 'file';
            this.#file.accept = '.png,.json,image/png,application/json';
            label.append(this.#file);
            this.#status.setAttribute('role', 'status');
            this.#preview.hidden = this.#confirm.disabled = true;
            const footer = node('footer');
            this.#confirm.className = 'primary';
            footer.append(this.#cancel, this.#confirm);
            this.#dialog.append(title, node('p', '支持 PNG（10 MiB）与 JSON（1 MiB）。选择文件后先预览；只导入下列纯文本，不保留图片、扩展或系统提示词。'),
                label, this.#status, this.#preview, footer);
            root.append(css, this.#open, this.#dialog);

            this.#open.addEventListener('click', () => this.#dialog.showModal());
            this.#file.addEventListener('change', () => void this.#readFile());
            this.#cancel.addEventListener('click', () => this.#dialog.close());
            this.#confirm.addEventListener('click', () => void this.#submit());
            this.#dialog.addEventListener('cancel', event => { if (this.#request) event.preventDefault(); });
            this.#dialog.addEventListener('close', () => {
                this.#reset();
                if (this.isConnected) this.#open.focus();
            });
        }

        disconnectedCallback() {
            this.#request?.abort();
            this.#request = null;
            if (this.#dialog.open) this.#dialog.close();
            this.#reset();
        }

        #reset() {
            this.#generation++;
            this.#profile = null;
            this.#file.value = '';
            this.#file.disabled = this.#cancel.disabled = false;
            this.#show('');
            this.#render();
        }

        async #readFile() {
            const selected = this.#file.files?.[0];
            const generation = ++this.#generation;
            this.#profile = null;
            this.#render();
            if (!selected) { this.#show(''); return; }
            this.#show('正在本机读取文件…');
            try {
                const format = /\.png$/i.test(selected.name) ? 'png' : /\.json$/i.test(selected.name) ? 'json' : null;
                if (!format) throw new Error('请选择 .png 或 .json 角色卡。');
                assertFileSize(selected.size, format);
                const bytes = new Uint8Array(await selected.arrayBuffer());
                if (generation !== this.#generation || !this.#dialog.open) return;
                this.#profile = parseCharacterCard(bytes, format);
                this.#show('请检查预览。超长文本已按字段上限截取。');
                this.#render();
            } catch (error) {
                if (generation === this.#generation && this.#dialog.open) {
                    this.#show(error instanceof Error ? error.message : '无法读取文件。', true);
                }
            }
        }

        async #submit() {
            if (!this.#profile || this.#request) return;
            const request = new AbortController();
            this.#request = request;
            this.#file.disabled = this.#confirm.disabled = this.#cancel.disabled = true;
            this.#show('正在创建本地角色…');
            try {
                const response = await fetch('/api/characters', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.#profile),
                    signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
                });
                const created = await response.json().catch(() => null);
                if (request.signal.aborted) return;
                if (!response.ok || typeof created?.id !== 'string' || !uuid.test(created.id)) {
                    throw new Error(typeof created?.error === 'string' ? created.error : '本机服务未返回有效角色。');
                }
                this.#dialog.close();
                this.dispatchEvent(new CustomEvent('write-character-created', { detail: created.id, bubbles: true, composed: true }));
            } catch (error) {
                if (!request.signal.aborted) {
                    const message = error?.name === 'TimeoutError'
                        ? '本机服务响应超时。再次导入前，请先检查角色列表。'
                        : error instanceof Error ? error.message : '无法创建角色。';
                    this.#show(message, true);
                }
            } finally {
                if (this.#request === request) {
                    this.#request = null;
                    this.#file.disabled = this.#cancel.disabled = false;
                    this.#render();
                }
            }
        }

        #render() {
            this.#preview.replaceChildren();
            this.#preview.hidden = !this.#profile;
            this.#confirm.disabled = !this.#profile || Boolean(this.#request);
            if (!this.#profile) return;
            for (const [title, text] of [['名称', this.#profile.name], ['设定', this.#profile.description], ['开场白', this.#profile.greeting || '（未填写）']]) {
                this.#preview.append(node('dt', title), node('dd', text));
            }
        }

        /** @param {string} text @param {boolean} [error] */
        #show(text, error = false) {
            this.#status.textContent = text;
            this.#status.classList.toggle('error', error);
        }
    }
    customElements.define('card-importer-panel', CardImporterPanel);
}

/** @param {string} text */
function button(text) {
    const element = node('button', text);
    element.type = 'button';
    return element;
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} [text] @returns {HTMLElementTagNameMap[T]} */
function node(tag, text = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
}
