/** Chat presentation for logged course-selection actions. */
import type { ConversationNodeDefinition, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Preserve authored text in historical follow-ups while suppressing the retired internal envelope. */
export const retiredExplanationContextRule: UserTextRule = {
  id: 'retired-course-explanation-context',
  order: 11,
  match(text, from) {
    const pattern = /<(course-explanation-state|studio-explanation-v1) (?:\d{1,16}|[a-f0-9]{64})>\r?\n/gu
    pattern.lastIndex = from
    const match = pattern.exec(text)
    if (match === null) return
    const closing = `</${match[1]}>`
    const close = text.indexOf(closing, pattern.lastIndex)
    if (close < 0) return
    const end = close + closing.length
    return { id: 'text', start: match.index, end, data: { text: text.slice(match.index, end), display: '' } }
  },
}

/** Claims automatic study inputs in Chat without changing their durable model-visible content. */
export const hiddenStudyActionDefinition: ConversationNodeDefinition = {
  kind: 'course-study-action-input',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    const source: unknown = event.data.source
    if (typeof source !== 'object' || source === null || !('kind' in source)
      || source.kind !== 'course-study-action') return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: () => null,
  update: () => null,
  buildViewNode: () => null,
}
