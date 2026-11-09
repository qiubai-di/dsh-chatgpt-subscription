import { PROVIDER_ID } from './catalog.js';
/** Keep DSH search for other routes and old history, not this provider's new calls. */
export function installSearchToolIsolation(ctx) {
    // Since DSH 0.2.2 the waterfall owns presentation only. The adapter removes
    // the callable schema at the request boundary below; execution stays guarded.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next();
        if ((context.modelSelection?.provider ?? assembled.variables.provider) !== PROVIDER_ID)
            return assembled;
        return {
            ...assembled,
            sections: assembled.sections.filter(section => section.name !== 'tool:web_search'),
        };
    }, { prepend: true });
    // The admitted header, not a selection changed during inference, owns the
    // tool request. A monotonic guard also covers nested tool dispatch.
    ctx.tools.guard(exec => exec.name === 'web_search'
        && exec.agent?.session.requestHeader()?.config.provider === PROVIDER_ID
        ? 'DSH web_search is disabled on this route; use the provider-native OpenAI web search.'
        : undefined);
}
/** Let Pi project tool history against this route's current callable schemas. */
export function isolateSubscriptionSearch(options) {
    if (options.provider !== PROVIDER_ID || options.tools === undefined)
        return options;
    return { ...options, tools: options.tools.filter(tool => tool.name !== 'web_search') };
}
//# sourceMappingURL=search-tool-isolation.js.map