import { PROVIDER_ID } from './catalog.js';
/** Keep DSH search for other routes and old history, not this provider's new calls. */
export function installSearchToolIsolation(ctx) {
    // Model selection resolves while unwinding the assembly waterfall. Inspect
    // its returned variables, rather than mutable UI/default Agent options.
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next();
        if (assembled.variables.provider !== PROVIDER_ID)
            return assembled;
        return {
            ...assembled,
            tools: assembled.tools.filter(tool => tool.name !== 'web_search'),
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
//# sourceMappingURL=search-tool-isolation.js.map