/** @param {import('../../src/kernel.js').PluginContext} ctx */
export function apply(ctx) {
    ctx.ui.registerSlot('toolbar', { tag: 'card-importer-panel', entry: 'card.js', style: 'card.css' });
}
