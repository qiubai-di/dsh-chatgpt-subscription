// Tests act as a compaction producer. Production adapters accept arbitrary
// purposes; the real host's dsh-compaction-basic owns this declaration.
import type {} from '@deepseek-ai/dsh-llm/types'
declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap { compaction: true; 'session-title': true }
}
