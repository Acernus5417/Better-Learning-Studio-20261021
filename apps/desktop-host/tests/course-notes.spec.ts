/** Final-answer eligibility is independent of thinking and partial streams. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { courseStudyRepliesProjection as definition } from '../src/course-notes.ts'

describe('learning note answer projection', () => {
  it('publishes only the final text answer after the turn closes', () => {
    const session = Session.create(SessionId('note-projection'), undefined, {
      id: SessionId('note-projection'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 0,
      isSeeded: false,
      cwd: '/course',
      agentPreset: 'better-learning-study',
    })
    let state: Parameters<typeof definition.apply>[0] = definition.init(session.header)
    state = definition.apply(state, session.append('turn/start', { turn: 1 }))
    state = definition.apply(
      state,
      session.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            source: { provider: 'test', model: 'test' },
            content: [{ type: 'text', text: 'Intermediate response' }],
          }),
        },
        { surfaceOp: 'append' },
      ),
    )
    state = definition.apply(
      state,
      session.append(
        'assistant/message',
        {
          turn: 1,
          step: 2,
          stream: [],
          message: createAssistantMessage({
            source: { provider: 'test', model: 'test' },
            content: [
              { type: 'reasoning', text: 'Internal reasoning' },
              { type: 'text', text: 'The final explanation.' },
            ],
          }),
        },
        { surfaceOp: 'append' },
      ),
    )
    expect(definition.wire.view(state)).toEqual([])
    state = definition.apply(state, session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(definition.wire.view(state).map((reply) => reply.text)).toMatchInlineSnapshot(`
      [
        "The final explanation.",
      ]
    `)
  })
  it('does not publish generation-session answers into the learning note picker', () => {
    const header: Parameters<typeof definition.init>[0] = {
      id: SessionId('generation'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 0,
      isSeeded: false,
      cwd: '/course',
      agentPreset: 'better-learning',
    }
    expect(definition.init(header).enabled).toBe(false)
  })
})
