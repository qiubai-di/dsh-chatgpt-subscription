import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { SiwcError } from './siwc-error.js';
function sameString(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
function issuedClientId(value) {
    return value !== 'dynamic_agent_client' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function reply(response, status, body) {
    response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        Connection: 'close',
    });
    response.end(body);
}
/** A single, state-bound callback. Invalid unsolicited callbacks do not consume it. */
export async function startLoopback(options) {
    if (options.signal?.aborted)
        throw new SiwcError('LOGIN_ABORTED', 'Sign-in was cancelled.');
    let completed = false;
    let resolveResult;
    let rejectResult;
    let redirectUri = '';
    let timer;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // A cancellation can arrive before the caller attaches its await.
    void result.catch(() => undefined);
    const settle = (error, value) => {
        if (completed)
            return;
        completed = true;
        if (timer !== undefined)
            clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error !== undefined)
            rejectResult(error);
        else if (value !== undefined)
            resolveResult(value);
    };
    const onAbort = () => settle(new SiwcError('LOGIN_ABORTED', 'Sign-in was cancelled.'));
    const server = createServer((request, response) => {
        if (completed) {
            reply(response, 410, 'This sign-in attempt has ended.');
            return;
        }
        if (request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host) {
            reply(response, 400, 'Invalid sign-in callback.');
            return;
        }
        let callback;
        try {
            callback = new URL(request.url ?? '/', redirectUri);
        }
        catch {
            reply(response, 400, 'Invalid sign-in callback.');
            return;
        }
        if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== '/auth/callback') {
            reply(response, 404, 'Not found.');
            return;
        }
        const query = callback.searchParams;
        if (['state', 'code', 'error', 'client_id'].some((field) => query.getAll(field).length > 1)) {
            reply(response, 400, 'Invalid sign-in callback.');
            return;
        }
        const state = query.get('state');
        if (state === null || !sameString(state, options.state)) {
            reply(response, 400, 'Invalid sign-in state. Return to the original sign-in page.');
            return;
        }
        if (query.has('error')) {
            reply(response, 400, 'Sign-in was not completed. Return to the terminal.');
            settle(new SiwcError('LOGIN_DENIED', 'Sign-in was declined or could not be completed.'));
            return;
        }
        const code = query.get('code');
        const returnedClientId = query.get('client_id');
        const clientId = returnedClientId ?? options.clientId;
        if (code === null || code.length === 0 || code.length > 4096 || clientId === undefined || !issuedClientId(clientId)) {
            reply(response, 400, 'The authorization callback is incomplete. Return to the terminal.');
            return;
        }
        if (options.clientId !== undefined && clientId !== options.clientId) {
            reply(response, 400, 'The authorization belongs to a different registration.');
            settle(new SiwcError('CLIENT_ID_MISMATCH', 'The returned client ID does not match the selected registration.'));
            return;
        }
        response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            Connection: 'close',
        });
        response.end('Authorization returned. You can close this page and return to the terminal.', () => {
            settle(undefined, { code, clientId });
        });
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => {
        const onError = () => reject(new SiwcError('CALLBACK_LISTENER_FAILED', 'Unable to start the local sign-in callback.'));
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
        server.close();
        throw new SiwcError('CALLBACK_LISTENER_FAILED', 'Unable to determine the local callback address.');
    }
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    server.on('error', () => settle(new SiwcError('CALLBACK_LISTENER_FAILED', 'The local sign-in callback stopped.')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted)
        onAbort();
    timer = setTimeout(() => settle(new SiwcError('LOGIN_TIMEOUT', 'Sign-in timed out. Start a new sign-in attempt.')), options.timeoutMs);
    timer.unref();
    let closing;
    const close = () => {
        if (closing !== undefined)
            return closing;
        if (!completed)
            settle(new SiwcError('LOGIN_ABORTED', 'Sign-in was cancelled.'));
        if (timer !== undefined)
            clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        closing = new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
        return closing;
    };
    // The pending callback owns the listener and releases it on timeout/cancellation too.
    void result.then(() => close(), () => close());
    return { redirectUri, result, close };
}
//# sourceMappingURL=loopback.js.map