import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { assistantDefinition } from '../../ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../../ui-chat/src/client/conversation-nodes/fallback.ts'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { hiddenStudyActionDefinition } from '../src/client/course/study-chat.ts'

const automaticPrompt = 'Explain this exact selection. Internal course action instructions stay in the session log.'
const actionSource = {
  kind: 'course-study-action',
  action: 'explain',
  courseId: 'test-course',
  quoteId: 'test-quote',
  promptVersion: 1,
}

function at(seq: number, type: string, data: unknown, append = false): SessionLiveEventEntry {
  // Fixtures represent the producer-owned source without importing the Desktop Host into the Client program.
  const event = {
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    type,
    data,
    ...(append ? { surfaceOp: 'append' as const } : {}),
  } as SessionEvent
  return { type: 'event', event }
}

function user(seq: number, id: string, text: string, source: object): SessionLiveEventEntry {
  return at(seq, 'user/message', {
    id, role: 'user', content: [{ type: 'text', text }], source,
  }, true)
}

function transcript(): readonly SessionLiveEventEntry[] {
  return [
    at(0, 'turn/start', { turn: 1 }),
    at(1, 'step/start', { turn: 1, step: 1 }),
    user(2, 'automatic', automaticPrompt, actionSource),
    at(3, 'assistant/message', {
      turn: 1, step: 1, stream: [],
      message: {
        id: 'answer', role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'Here is the explanation.' }],
      },
    }, true),
    user(4, 'manual', 'Please explain the example again.', { kind: 'user' }),
  ]
}

function createAssembler(definitions: readonly ConversationNodeDefinition[]): ConversationNodeAssembler {
  const assembler = new ConversationNodeAssembler({
    entries: () => definitions,
    fallbackEntry: () => unknownFallbackDefinition,
  }, { entries: () => [chatViewDefinition] })
  assembler.activateTarget('chat')
  return assembler
}

function visible(assembler: ConversationNodeAssembler) {
  const snapshot = assembler.get('chat')
  if (snapshot === undefined) throw new Error('Chat was not activated')
  return snapshot.order.map(key => snapshot.nodes.get(key)).filter(node => node !== undefined)
}

describe('automatic study action Chat presentation', () => {
  it.each(['before', 'after'] as const)('hides automatic prompts when registered %s the ordinary input definition', (position) => {
    const definitions = position === 'before'
      ? [hiddenStudyActionDefinition, messageDefinition, assistantDefinition]
      : [messageDefinition, assistantDefinition, hiddenStudyActionDefinition]
    const assembler = createAssembler(definitions)
    const entries = transcript()
    const logged = JSON.stringify(entries)
    assembler.replaceWindow(entries, false)
    assembler.flush()

    const rows = visible(assembler)
    expect(rows.map(row => row.kind)).toEqual(['assistant-step', 'user'])
    expect(rows.map(row => row.data)).toMatchSnapshot()
    expect(JSON.stringify(rows)).not.toContain(automaticPrompt)
    expect(JSON.stringify(rows)).toContain('Here is the explanation.')
    expect(JSON.stringify(rows)).toContain('Please explain the example again.')
    expect(JSON.stringify(entries)).toBe(logged)
    expect(logged).toContain(automaticPrompt)
    expect(logged).toContain('course-study-action')
  })

  it('keeps the same presentation during live append and history replay', () => {
    const assembler = createAssembler([messageDefinition, assistantDefinition, hiddenStudyActionDefinition])
    const entries = transcript()
    for (const entry of entries) {
      assembler.append(entry)
      assembler.flush()
      expect(JSON.stringify(visible(assembler))).not.toContain(automaticPrompt)
    }
    const liveRows = visible(assembler)
    assembler.replaceWindow(entries, false)
    assembler.flush()
    expect(visible(assembler)).toEqual(liveRows)
  })

  it('retains manually typed text even when it matches an automatic prompt', () => {
    const assembler = createAssembler([messageDefinition, assistantDefinition, hiddenStudyActionDefinition])
    assembler.replaceWindow([user(0, 'manual-copy', automaticPrompt, { kind: 'user' })], false)
    assembler.flush()
    expect(visible(assembler).map(row => row.kind)).toEqual(['user'])
    expect(JSON.stringify(visible(assembler))).toContain(automaticPrompt)
  })

  it('claims only user messages carrying the study-action source', () => {
    const automatic = user(0, 'automatic', automaticPrompt, actionSource)
    expect(hiddenStudyActionDefinition.match(automatic.event)).toEqual({
      id: 'automatic', role: 'start', exclusive: true,
    })
    expect(hiddenStudyActionDefinition.match(user(1, 'manual', automaticPrompt, { kind: 'user' }).event)).toBeNull()
    expect(hiddenStudyActionDefinition.match(user(2, 'context', automaticPrompt, { kind: 'context' }).event)).toBeNull()
    expect(hiddenStudyActionDefinition.match(at(3, 'developer/message', { source: actionSource }).event)).toBeNull()
    expect(hiddenStudyActionDefinition.match(at(4, 'assistant/message', { source: actionSource }).event)).toBeNull()
  })
})
