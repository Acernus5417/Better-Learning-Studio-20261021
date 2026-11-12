/** Learning answer projection and explicit, learner-reviewed note writes. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CourseStudyReply } from '@deepseek-ai/dsh-util-course-document'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { CourseLibrary, CourseLibraryError } from './course-library.ts'

interface ReplyState {
  readonly enabled: boolean
  readonly replies: readonly CourseStudyReply[]
  readonly draft: CourseStudyReply | null
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Full final-answer state is projected only for learning Sessions. */
    courseStudyReplies: ReplyState
  }
}
const replySchema = z
  .object({
    id: z.string().transform(value => value as MessageId),
    text: z.string(),
    time: z.number(),
  })
  .strict()
const repliesSchema = z.array(replySchema)
const stateSchema: z.ZodType<ReplyState> = z
  .object({ enabled: z.boolean(), replies: repliesSchema, draft: replySchema.nullable() })
  .strict()

/** Final answer text is published after the turn settles, never from partial tokens. */
export const courseStudyRepliesProjection = {
  key: 'courseStudyReplies',
  stateVersion: 1,
  stateSchema,
  init: header => ({ enabled: header.agentPreset === 'better-learning-study', replies: [], draft: null }),
  apply: (state, event) => {
    if (!state.enabled) return state
    if (event.type === 'turn/start') return state.draft === null ? state : { ...state, draft: null }
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n\n')
        .trim()
      if (text === '') return state
      return { ...state, draft: { id: event.data.message.id, text, time: event.time } }
    }
    if (event.type !== 'turn/end' || state.draft === null) return state
    return { ...state, replies: [...state.replies, state.draft], draft: null }
  },
  wire: { viewSchema: repliesSchema, view: state => state.replies },
} satisfies ProjectionDefinition<'courseStudyReplies', ReplyState>

/** Reviewed notes capture an exact source document and selected, settled replies. */
export interface CourseNoteRequest {
  readonly id: string
  readonly sessionId: SessionId
  readonly path: string
  readonly messageIds: readonly string[]
  readonly text: string
  readonly operationId: string
}

/**
 * Verify answer identities against the managed tutor before appending the reviewed draft.
 * @param ctx - Host owning the existing Session projection and course Workspaces.
 * @param library - Fixed course library.
 * @param request - Source document, selected replies and editable note preview.
 * @returns The note path, created on first use and otherwise appended.
 */
export async function writeCourseNote(
  ctx: Context,
  library: CourseLibrary,
  request: CourseNoteRequest,
): Promise<{ path: string; created: boolean }> {
  const course = (await library.list()).find(item => item.id === request.id)
  if (course?.learningSessionId !== request.sessionId)
    throw new CourseLibraryError('The learning Session belongs to a different course', 403)
  const resolved = await ctx.sessionController.resolveAgent(request.sessionId)
  if ('error' in resolved) throw new CourseLibraryError('The learning Session is unavailable')
  const agent = resolved.agent
  const workspace = ctx.workspaceRegistry.list().find(item => item.id === course.workspaceId)
  if (workspace?.path !== agent.session.header.cwd || agent.session.header.agentPreset !== 'better-learning-study')
    throw new CourseLibraryError('The learning Session binding changed', 403)
  const state = ctx.sessionProjections.stateOf(agent.session, 'courseStudyReplies')
  const ids = new Set(request.messageIds)
  if (
    ids.size === 0 ||
    ids.size > 100 ||
    state === undefined ||
    !state.enabled ||
    [...ids].some(id => !state.replies.some(reply => reply.id === id))
  )
    throw new CourseLibraryError('Select completed answers from this learning Session', 400)
  return library.appendNote(request.id, request.path, request.text, request.operationId, [...ids])
}
