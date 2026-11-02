import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MANAGE_USAGE_URL, PLAN_NOTICE, PLAN_PROVIDER_ID } from '../plan-contract.js'

export const inject = ['slots', 'modelDirectories']
interface DirectorySource {
  getSnapshot(): ModelDirectoryState
  subscribe(listener: () => void): () => void
}
interface Injected {
  directory: DirectorySource
}
type PlanProps = PropsRuntime<'conversation.input.dock'> & Injected
const rowStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px',
  minWidth: 0, padding: '6px 4px', fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

/** Personal-use display: show the request's plan source, never account identity or status. */
export function PlanStatusRow() {
  return <div style={rowStyle} data-chatgpt-plan-status="">
    <span>{PLAN_NOTICE.title}</span>
    <a href={MANAGE_USAGE_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--dsw-alias-state-business-primary)' }}>{PLAN_NOTICE.manageUsage}</a>
  </div>
}

export function ChatgptPlan(props: PlanProps) {
  const directory = useSyncExternalStore(
    listener => props.directory.subscribe(listener),
    () => props.directory.getSnapshot(),
    () => props.directory.getSnapshot(),
  )
  if (props.session.subagent !== null || directory.current?.provider !== PLAN_PROVIDER_ID) return null
  return <section style={{
    boxSizing: 'border-box', minWidth: 0,
    width: 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance))',
    maxWidth: 'var(--dsh-composer-card-max-width)', marginInline: 'auto',
  }} aria-label="ChatGPT plan usage"><PlanStatusRow /></section>
}

/** Register only the native display slot; no Connection or account reads are needed. */
export function apply(ctx: Context): void {
  const models = ctx.modelDirectories
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'chatgpt-plan-status',
    order: 100,
    inject: sessionId => ({ directory: models.directoryFor(sessionId).store }),
  }, ChatgptPlan))
}
