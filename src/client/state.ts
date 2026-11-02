import { MANAGE_USAGE_URL, PLAN_RPC_CHANNEL } from '../plan-contract.js'
import type { PlanStatus } from '../plan-contract.js'

/** Deliberately narrow browser transport: no credential or Host implementation imports. */
export interface PlanRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}
export interface PlanClientSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly status?: PlanStatus
  readonly confirming: boolean
  readonly confirmationFailed: boolean
}
const EMPTY: PlanClientSnapshot = { phase: 'idle', confirming: false, confirmationFailed: false }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Exact wire allowlist; reject unexpected fields rather than retaining a raw response. */
export function parsePlanStatus(value: unknown): PlanStatus {
  if (!object(value) || Object.keys(value).some(key => !['authorization', 'accountLabel', 'manageUsageUrl', 'noticeRequired', 'noticeId'].includes(key)) ||
      (value.authorization !== 'saved' && value.authorization !== 'missing') ||
      typeof value.accountLabel !== 'string' || value.accountLabel.trim().length === 0 || value.accountLabel.length > 320 || /[\u0000-\u001f\u007f]/.test(value.accountLabel) ||
      value.manageUsageUrl !== MANAGE_USAGE_URL || typeof value.noticeRequired !== 'boolean' ||
      (value.noticeId !== undefined && (typeof value.noticeId !== 'string' || !/^[a-f0-9]{64}$/.test(value.noticeId))) ||
      (value.noticeRequired && (value.authorization !== 'saved' || value.noticeId === undefined)) ||
      (value.authorization === 'missing' && (value.noticeRequired || value.noticeId !== undefined))) {
    throw new Error('Invalid plan status')
  }
  return {
    authorization: value.authorization as PlanStatus['authorization'],
    accountLabel: value.accountLabel,
    manageUsageUrl: MANAGE_USAGE_URL,
    noticeRequired: value.noticeRequired,
    ...(value.noticeId === undefined ? {} : { noticeId: value.noticeId as string }),
  }
}
function decodeResult(result: unknown): PlanStatus {
  if (!object(result) || result.ok !== true) throw new Error('Plan request unavailable')
  return parsePlanStatus(result.value)
}

/** Cancellation and monotone generations prevent stale account responses crossing sessions. */
export class PlanClientState {
  private snapshot: PlanClientSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private active = false
  private generation = 0
  private operation: AbortController | undefined
  constructor(private readonly rpc: PlanRpc) {}
  readonly getSnapshot = (): PlanClientSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(snapshot: PlanClientSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (active) void this.refresh()
    else {
      ++this.generation
      this.operation?.abort()
      this.operation = undefined
      this.publish(EMPTY)
    }
  }
  async refresh(force = false): Promise<void> {
    if (!this.active || (this.snapshot.confirming && !force)) return
    // Focus bursts coalesce; a new connection generation invalidates old operations.
    if (this.snapshot.phase === 'loading' && !force) return
    await this.request('status', {})
  }
  async acknowledge(): Promise<void> {
    const status = this.snapshot.status
    if (!this.active || this.snapshot.confirming || !status?.noticeRequired || status.noticeId === undefined) return
    await this.request('acknowledge', { noticeId: status.noticeId })
  }
  private async request(endpoint: 'status' | 'acknowledge', payload: object): Promise<void> {
    const generation = ++this.generation
    this.operation?.abort()
    const controller = new AbortController()
    this.operation = controller
    const previous = this.snapshot.status
    this.publish(endpoint === 'acknowledge'
      ? { phase: 'ready', status: previous!, confirming: true, confirmationFailed: false }
      : { phase: 'loading', confirming: false, confirmationFailed: false })
    try {
      const status = decodeResult(await this.rpc.call(PLAN_RPC_CHANNEL, endpoint, payload, controller.signal))
      if (!this.active || controller.signal.aborted || generation !== this.generation) return
      if (endpoint === 'acknowledge' && (status.noticeRequired || status.authorization !== 'saved')) throw new Error('Confirmation not saved')
      this.publish({ phase: 'ready', status, confirming: false, confirmationFailed: false })
    } catch {
      if (!this.active || controller.signal.aborted || generation !== this.generation) return
      // A failed confirmation keeps its explanation visible. Never display raw transport errors.
      this.publish(endpoint === 'acknowledge'
        ? { phase: 'error', confirming: false, confirmationFailed: true }
        : { phase: 'error', confirming: false, confirmationFailed: false })
    } finally {
      if (generation === this.generation) this.operation = undefined
    }
  }
  dispose(): void {
    this.setActive(false)
    ++this.generation
    this.operation?.abort()
    this.listeners.clear()
  }
}
