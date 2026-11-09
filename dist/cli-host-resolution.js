import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
/** Standalone CLI processes have no DSH boot resolver. Use their recorded host. */
export function installCliHostResolution(dshExecutable) {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const peers = new Set(Object.keys(manifest.peerDependencies));
    const parentURL = pathToFileURL(dshExecutable).href;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            return nextResolve(specifier, peers.has(name) ? { ...context, parentURL } : context);
        },
    });
}
//# sourceMappingURL=cli-host-resolution.js.map