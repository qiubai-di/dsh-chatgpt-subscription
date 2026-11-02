import type { ConnectionRpcHandler, ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import { acknowledgePlanNotice, PlanStatusError, readPlanStatus } from './plan-status.js'

type Source = Parameters<typeof readPlanStatus>[0]
const failure = (code: string, message: string): ConnectionRpcHandlerResult =>
  ({ ok: false, error: { code, message, details: {} } })
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Register only through Connection.rpc.handle, whose carrier admits/authenticates first. */
export function planRpcHandler(source: Source, active: () => boolean = () => true): ConnectionRpcHandler {
  return async (endpoint, payload, signal, peer) => {
    // Raw RPC does not inherit the API gateway's endpoint ownership policy.
    if (peer.principal.kind !== 'owner') return failure('forbidden', 'Only the host owner can access ChatGPT account information.')
    if (!active() || signal.aborted || peer.signal.aborted) return failure('cancelled', 'The ChatGPT account request was cancelled.')
    const requestSignal = AbortSignal.any([signal, peer.signal])
    try {
      if (!object(payload)) return failure('invalid_request', 'Invalid ChatGPT account request.')
      let value
      if (endpoint === 'status' && Object.keys(payload).length === 0) {
        value = await readPlanStatus(source, requestSignal)
      } else if (endpoint === 'acknowledge' && Object.keys(payload).length === 1 &&
        typeof payload.noticeId === 'string' && /^[0-9a-f]{64}$/.test(payload.noticeId)) {
        value = await acknowledgePlanNotice(source, payload.noticeId, requestSignal)
      } else return failure('invalid_request', 'Only local account status and notice acknowledgement are supported.')
      requestSignal.throwIfAborted()
      if (!active()) return failure('cancelled', 'The ChatGPT account request was cancelled.')
      return { ok: true, value }
    } catch (error) {
      if (requestSignal.aborted || !active()) return failure('cancelled', 'The ChatGPT account request was cancelled.')
      if (error instanceof PlanStatusError) return failure(error.code, error.message)
      // The raw carrier exposes String(error) for unhandled exceptions. Never let one escape.
      return failure('internal', 'ChatGPT account information is unavailable. Retry without changing your authorization.')
    }
  }
}
