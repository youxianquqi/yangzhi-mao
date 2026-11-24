import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindToolbarCharacterCreated, createExtensionRegistry, updateDefaultModule, updateToolbar } from '../public/extensions.js';

const override = {
    pluginId: 'chapter-chooser', slot: 'thread-selector',
    tag: 'chapter-chooser-panel', entry: '/plugin-assets/chapter-chooser/panel.js',
};
const claim = { pluginId: override.pluginId, slot: override.slot, action: 'override' };

test('default surfaces are reversibly replaced or hidden; settings cannot be claimed', async t => {
    installDom(t, override.tag);
    const fallback = new TestElement();
    const target = new TestElement();
    let data = {
        registry: [override],
        claims: [claim, { ...claim, slot: 'settings', action: 'hide' }],
    };
    const registry = createExtensionRegistry(async () => data, async () => true);
    const render = () => updateDefaultModule('thread-selector', fallback, target, 'cat', 'chapter', registry);
    await registry.discover(render);
    const mount = target.firstElementChild;
    assert.equal(fallback.hidden, true);
    assert.equal(target.hidden, false);
    assert.equal(mount.shadowRoot.firstElementChild.getAttribute('thread-id'), 'chapter');
    assert.equal(registry.effect('settings').hidden, false);

    data = { registry: [], claims: [{ ...claim, action: 'hide' }] };
    await registry.discover(render);
    assert.equal(target.firstElementChild, null);
    assert.equal(mount.parent, null);
    assert.equal(fallback.hidden, true);
    assert.equal(target.hidden, true);

    data = { registry: [], claims: [] };
    await registry.discover(render);
    assert.equal(fallback.hidden, false);
    assert.equal(target.hidden, true);
});

test('a loading override cannot suppress the default or remount after disable', async () => {
    let data = {
        registry: [{ ...override, entry: 'https://elsewhere.invalid/panel.js' }, override],
        claims: [claim],
    };
    const attempted = [];
    const loader = Promise.withResolvers();
    const registry = createExtensionRegistry(async () => data, item => {
        attempted.push(item.entry);
        return loader.promise;
    });
    const old = registry.discover(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(registry.effect('thread-selector').hidden, false);
    assert.deepEqual(attempted, [override.entry]);

    data = { registry: [], claims: [] };
    await registry.discover(() => {});
    loader.resolve(true);
    await old;
    assert.deepEqual(registry.items('thread-selector'), []);
    assert.equal(registry.effect('thread-selector').hidden, false);
});

test('a replacement component that cannot be constructed leaves the default usable', async t => {
    installDom(t, override.tag, false);
    t.mock.method(console, 'warn', () => {});
    const fallback = new TestElement();
    const target = new TestElement();
    const registry = createExtensionRegistry(async () => ({ registry: [override], claims: [claim] }), async () => true);
    await registry.discover(() => updateDefaultModule('thread-selector', fallback, target, null, null, registry));
    assert.equal(fallback.hidden, false);
    assert.equal(target.firstElementChild, null);
});


test('additive toolbar mounts with no active role and releases its component on dispose', async t => {
    const item = { ...override, slot: 'toolbar' };
    installDom(t, item.tag);
    const target = new TestElement();
    let ui = [item];
    const registry = createExtensionRegistry(async () => ({
        registry: ui, claims: [{ slot: 'toolbar', pluginId: item.pluginId, action: 'hide' }],
    }), async () => true);
    const update = (role = null) => updateToolbar(target, role, null, registry);
    await registry.discover(update);
    const mount = target.firstElementChild;
    const tool = mount.shadowRoot.firstElementChild;
    assert.equal(target.hidden, false);
    assert.equal(tool.getAttribute('character-id'), null);
    assert.equal(registry.effect('toolbar').hidden, false);

    update('cat');
    assert.equal(target.firstElementChild, mount);
    assert.equal(tool.getAttribute('character-id'), 'cat');

    ui = [];
    await registry.discover(update);
    assert.equal(target.hidden, true);
    assert.equal(mount.parent, null);
});

test('the toolbar accepts created role IDs only from an active mount', () => {
    const ids = [];
    const toolbar = new EventTarget();
    const mount = new EventTarget();
    const child = new EventTarget();
    toolbar.children = [mount];
    bindToolbarCharacterCreated(toolbar, id => ids.push(id));
    const id = '01f09597-e4d3-467f-a588-e3800b169c5e';
    notify(id, [toolbar]);
    notify('../../unknown', [child, mount, toolbar]);
    notify(id + '\n', [child, mount, toolbar]);
    notify({ id }, [child, mount, toolbar]);
    notify(id, [child, mount, toolbar], false);
    notify(id.toUpperCase(), [child, mount, toolbar]);
    assert.deepEqual(ids, [id]);

    function notify(detail, path, composed = true) {
        const event = new CustomEvent('write-character-created', { detail, bubbles: true, composed });
        event.composedPath = () => path;
        toolbar.dispatchEvent(event);
    }
});

// Only the DOM operations used by the mount are needed; no browser dependency.
class TestElement {
    children = [];
    parent = null;
    dataset = {};
    attrs = new Map();
    get firstElementChild() { return this.children[0] ?? null; }
    append(node) {
        this.children.push(node);
        node.parent = this;
    }
    remove() {
        this.parent.children = this.parent.children.filter(node => node !== this);
        this.parent = null;
    }
    attachShadow() { return this.shadowRoot = new TestElement(); }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
}

function installDom(t, tag, successful = true) {
    class PluginElement extends TestElement {}
    const elements = new Map([[tag, PluginElement]]);
    const additions = {
        HTMLElement: TestElement,
        document: { createElement: name => new (name === tag && !successful ? TestElement : elements.get(name))() },
        customElements: { get: name => elements.get(name), define: (name, ctor) => elements.set(name, ctor) },
    };
    for (const [key, value] of Object.entries(additions)) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => {
            if (original) Object.defineProperty(globalThis, key, original);
            else delete globalThis[key];
        });
    }
}
