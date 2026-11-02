import { createHash } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SiwcCredential } from './siwc.js'
import { MANAGE_USAGE_URL } from './plan-contract.js'
import type { PlanStatus } from './plan-contract.js'

type PlanIdentity = Pick<SiwcCredential, 'clientId' | 'issuer' | 'subject' | 'email'>
interface PlanStatusSource {
  /** Local read only. The implementation must never refresh or contact OpenAI. */
  credential(): Promise<PlanIdentity | undefined>
  readonly credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>
}

export class PlanStatusError extends Error {
  constructor(readonly code: 'NO_ACTIVE_ACCOUNT' | 'ACCOUNT_CHANGED' | 'INVALID_NOTICE_STATE') {
    super({
      NO_ACTIVE_ACCOUNT: 'No saved ChatGPT account. Manage sign-in with the local dsh-chatgpt command.',
      ACCOUNT_CHANGED: 'The ChatGPT account changed. Reload its plan information before confirming.',
      INVALID_NOTICE_STATE: 'The local ChatGPT plan notice could not be read safely.',
    }[code])
    this.name = 'PlanStatusError'
  }
}

function noticeId(identity: PlanIdentity): string {
  // An OAuth client identifies the application, not the user. Bind all identity parts.
  return createHash('sha256').update(JSON.stringify([
    'dsh-chatgpt-plan-notice-v1', identity.issuer, identity.subject, identity.clientId,
  ])).digest('hex')
}

function noticeKey(id: string) {
  return credentialKey('chatgpt-subscription', `notice-${id}`)
}

function acknowledged(record: CredentialRecord | undefined): boolean {
  if (record === undefined) return false
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null ||
      Array.isArray(record.payload)) throw new PlanStatusError('INVALID_NOTICE_STATE')
  const value = record.payload as Record<string, unknown>
  if (value.version !== 1 || value.acknowledged !== true) throw new PlanStatusError('INVALID_NOTICE_STATE')
  return true
}

/** Only reads local state. In particular, never refreshes a grant or calls /models. */
export async function readPlanStatus(source: PlanStatusSource, signal?: AbortSignal): Promise<PlanStatus> {
  signal?.throwIfAborted()
  const identity = await source.credential()
  signal?.throwIfAborted()
  if (identity === undefined) {
    return { authorization: 'missing', accountLabel: 'Not signed in', manageUsageUrl: MANAGE_USAGE_URL, noticeRequired: false }
  }
  const id = noticeId(identity)
  const seen = acknowledged(await source.credentials.readRecord(noticeKey(id)))
  signal?.throwIfAborted()
  return {
    authorization: 'saved',
    accountLabel: identity.email?.trim() || 'Signed-in ChatGPT account',
    manageUsageUrl: MANAGE_USAGE_URL,
    noticeRequired: !seen,
    ...(!seen ? { noticeId: id } : {}),
  }
}

/** Records an informational notice only; it never changes OAuth consent or credits. */
export async function acknowledgePlanNotice(
  source: PlanStatusSource, expectedId: string, signal?: AbortSignal,
): Promise<PlanStatus> {
  signal?.throwIfAborted()
  const identity = await source.credential()
  if (identity === undefined) throw new PlanStatusError('NO_ACTIVE_ACCOUNT')
  const currentId = noticeId(identity)
  if (expectedId !== currentId) throw new PlanStatusError('ACCOUNT_CHANGED')
  signal?.throwIfAborted()
  await source.credentials.modifyRecord(noticeKey(currentId), async current => {
    signal?.throwIfAborted()
    if (acknowledged(current)) return undefined
    return { kind: 'grant', payload: { version: 1, acknowledged: true } }
  })
  return readPlanStatus(source, signal)
}
