// Same-origin settings. Secrets are write-only input; the read view is metadata.

/** @typedef {'deepseek'|'minimax'} PresetId */
/** @typedef {{id:PresetId,name:string,baseUrl:string,model:string}} Preset */
/** @typedef {{preset:PresetId,baseUrl:string,model:string,apiKeyConfigured:boolean,apiKeyLast4:string|null,apiKeySource:'environment'|'saved'|null,configured:boolean,presets:Preset[]}} ModelView */
/** @typedef {{id:string,name:string,version:string,enabled:boolean,active:boolean,toggleable:boolean,overrides:string[],hides:string[],state:'active'|'disabled'|'safe-mode'|'failed'}} PluginView */
/** @typedef {{safeMode:boolean,model:ModelView,plugins:PluginView[],activeAgent:string,modelAvailable:boolean}} SettingsView */
/** @typedef {{preset:string,baseUrl:string,model:string,apiKey?:string|null}} ModelFields */
/** @typedef {(path:string, options?:{method?:string,data?:unknown}) => Promise<unknown>} Api */

const slotLabels = new Map([
    ['agent', '后端模型服务'], ['storage', '后端存档服务'], ['promptBuilder', '后端提示词构建'],
    ['character-sidebar', '默认角色侧栏'], ['thread-selector', '默认剧情线选择器'], ['main-view', '默认聊天记录视图'],
]);
const states = {
    active: '运行中', disabled: '已停用', 'safe-mode': '安全模式：未加载', failed: '启用失败：未加载',
};

/**
 * @param {Api} api
 * @param {(settings:SettingsView,previous:SettingsView|null,refreshPlugins:boolean) => void} onChange
 */
export function createSettingsPanel(api, onChange) {
    const dialog = /** @type {HTMLDialogElement} */ (node('settings-dialog'));
    const preset = /** @type {HTMLSelectElement} */ (node('model-preset'));
    const baseUrl = /** @type {HTMLInputElement} */ (node('model-base-url'));
    const model = /** @type {HTMLInputElement} */ (node('model-name'));
    const apiKey = /** @type {HTMLInputElement} */ (node('model-api-key'));
    const clearKey = /** @type {HTMLInputElement} */ (node('model-forget-key'));
    const form = /** @type {HTMLFormElement} */ (node('model-form'));
    const fieldset = /** @type {HTMLFieldSetElement} */ (node('model-fields'));
    const plugins = node('settings-plugins');
    const feedback = node('settings-feedback');
    const retry = /** @type {HTMLButtonElement} */ (node('retry-settings'));
    /** @type {SettingsView|null} */
    let current = null;
    let busy = false;

    node('open-settings').addEventListener('click', open);
    node('close-settings').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        apiKey.value = '';
        clearKey.checked = false;
        apiKey.disabled = false;
    });
    retry.addEventListener('click', () => void refresh());
    preset.addEventListener('change', () => {
        const selected = current?.model.presets.find(item => item.id === preset.value);
        if (!selected) return;
        baseUrl.value = selected.id === current?.model.preset ? current.model.baseUrl : selected.baseUrl;
        model.value = selected.id === current?.model.preset ? current.model.model : selected.model;
        apiKey.value = '';
        clearKey.checked = false;
        apiKey.disabled = false;
        showKeyStatus();
    });
    clearKey.addEventListener('change', () => {
        if (clearKey.checked) apiKey.value = '';
        apiKey.disabled = clearKey.checked;
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        void operate(async () => {
            const next = await api('/settings/model', { method: 'PUT', data: fields() });
            apply(/** @type {SettingsView} */ (next), false, true);
            status('模型设置已保存。');
        });
    });
    node('test-model').addEventListener('click', () => {
        if (!form.reportValidity()) return;
        void operate(async () => {
            const result = /** @type {{ok?:boolean}|null} */ (await api('/settings/model/test', { method: 'POST', data: fields() }));
            if (!result?.ok) throw new Error('模型服务未确认连接成功。');
            status('连接成功。此次测试不会保存设置。');
        });
    });

    function open() {
        if (dialog.open) return;
        dialog.showModal();
        void refresh();
    }

    async function read() {
        return /** @type {SettingsView} */ (await api('/settings'));
    }

    async function refresh() {
        retry.hidden = true;
        await operate(async () => {
            try { apply(await read(), true, true); }
            catch (error) { retry.hidden = false; throw error; }
        });
    }

    /** @returns {ModelFields} */
    function fields() {
        /** @type {ModelFields} */
        const data = { preset: preset.value, baseUrl: baseUrl.value.trim(), model: model.value.trim() };
        if (clearKey.checked) data.apiKey = null;
        else if (apiKey.value.trim()) data.apiKey = apiKey.value.trim();
        return data;
    }

    /** @param {SettingsView} next @param {boolean} refreshPlugins @param {boolean} updateFields */
    function apply(next, refreshPlugins, updateFields) {
        const previous = current;
        current = next;
        node('settings-safe-mode').hidden = !next.safeMode;
        node('active-model').textContent = next.activeAgent ? '当前模型服务：' + next.activeAgent : '';
        if (updateFields) {
            preset.replaceChildren(...next.model.presets.map(item => {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = item.name;
                return option;
            }));
            preset.value = next.model.preset;
            baseUrl.value = next.model.baseUrl;
            model.value = next.model.model;
            apiKey.value = '';
            clearKey.checked = false;
            apiKey.disabled = false;
            showKeyStatus();
        }
        plugins.replaceChildren(...next.plugins.map(pluginItem));
        if (!next.plugins.length) plugins.textContent = '没有可配置的插件。';
        onChange(next, previous, refreshPlugins);
    }

    function showKeyStatus() {
        const saved = current?.model;
        const samePreset = saved?.preset === preset.value;
        node('model-key-status').textContent = samePreset && saved?.apiKeyConfigured
            ? '已配置' + (saved.apiKeyLast4 ? '，尾号 …' + saved.apiKeyLast4 : '') + (saved.apiKeySource === 'environment' ? '（环境变量优先）' : '')
            : '此处不显示原密钥；如未配置，请输入获取的 API Key。';
        node('model-forget-label').hidden = !samePreset || saved?.apiKeySource !== 'saved';
    }

    /** @param {PluginView} plugin */
    function pluginItem(plugin) {
        const item = document.createElement('li');
        const details = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = plugin.name;
        const meta = document.createElement('div');
        meta.className = 'feedback';
        meta.textContent = [plugin.id, states[plugin.state]].join(' · ');
        details.append(name, meta);
        const claims = [
            plugin.overrides.length ? '接管：' + plugin.overrides.map(slotLabel).join('、') : '',
            plugin.hides.length ? '隐藏：' + plugin.hides.map(slotLabel).join('、') : '',
        ].filter(Boolean);
        if (claims.length) {
            const declarations = document.createElement('p');
            declarations.className = 'feedback';
            declarations.textContent = claims.join('；');
            details.append(declarations);
        }
        item.append(details);
        if (plugin.toggleable) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-secondary';
            button.textContent = plugin.enabled ? '停用' : '启用';
            button.setAttribute('aria-label', button.textContent + ' ' + plugin.name);
            button.addEventListener('click', () => void operate(async () => {
                const next = /** @type {SettingsView} */ (await api('/settings/plugins/' + encodeURIComponent(plugin.id), {
                    method: 'PUT', data: { enabled: !plugin.enabled },
                }));
                apply(next, true, false);
                const updated = next.plugins.find(row => row.id === plugin.id);
                if (updated?.state === 'failed') status('启用已保存，但插件没有成功加载。', true);
                else if (updated?.state === 'safe-mode') status('启用已保存；退出安全模式并重启后才会加载。');
                else status(updated?.active ? '插件已启用。' : '插件已停用。');
                const index = next.plugins.findIndex(row => row.id === plugin.id);
                return plugins.children[index]?.querySelector('button') ?? null;
            }));
            item.append(button);
        } else {
            const note = document.createElement('span');
            note.className = 'feedback';
            note.textContent = '文件配置';
            item.append(note);
        }
        return item;
    }

    /** @param {() => Promise<HTMLElement|null|void>} task */
    async function operate(task) {
        if (busy) return;
        busy = true;
        syncBusy();
        status('处理中…');
        let focusAfter;
        try {
            focusAfter = await task();
            if (feedback.textContent === '处理中…') status('');
        } catch (error) {
            status(error instanceof Error ? error.message : '设置请求失败。', true);
        } finally {
            busy = false;
            syncBusy();
            if (dialog.open && focusAfter) focusAfter.focus();
        }
    }

    function syncBusy() {
        fieldset.disabled = busy || !current;
        for (const button of plugins.querySelectorAll('button')) button.disabled = busy;
    }

    /** @param {string} value @param {boolean} [error] */
    function status(value, error = false) {
        feedback.textContent = value;
        feedback.classList.toggle('error', error);
    }

    syncBusy();
    return { open, read };
}

/** @param {string} value */
function slotLabel(value) {
    return slotLabels.get(value) ?? value;
}

/** @param {string} id */
function node(id) {
    const result = document.getElementById(id);
    if (!result) throw new Error('Missing settings element: ' + id);
    return result;
}
