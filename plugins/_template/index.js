// Optional starter hook; exposes no I/O or routes until explicitly enabled.

/** @typedef {import('../../src/kernel.js').PluginContext} PluginContext */
/** @typedef {{label?: string}} TemplateConfig */

/**
 * @param {PluginContext} ctx
 * @param {TemplateConfig} config
 * @returns {void}
 */
export function apply(ctx, config) {
    const label = typeof config?.label === 'string' ? config.label.trim().slice(0, 80) : '';
    if (!label) return;
    ctx.on('beforePrompt', ({ sessionId }) => sessionId === null ? { label } : undefined);
}
