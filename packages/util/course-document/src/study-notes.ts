/** Settled tutor answers eligible for the learner's document notes. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Answer text excludes thinking, tools, prompts and unfinished streams. */
export interface CourseStudyReply {
  readonly id: MessageId
  readonly text: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole learning-session answer list used for single or multiple selection. */
    courseStudyReplies: readonly CourseStudyReply[]
  }
}

/**
 * Prepare an editable Markdown preview in conversation order, retaining answers verbatim.
 * @param replies - Selected answers in their original order.
 * @returns One Markdown section per distinct selected answer.
 */
export function organizeCourseNotes(replies: readonly CourseStudyReply[]): string {
  const seen = new Set<string>()
  return replies
    .flatMap((reply) => {
      const text = reply.text.trim()
      if (text === '' || seen.has(text)) return []
      seen.add(text)
      return [text]
    })
    .join('\n\n---\n\n')
}
