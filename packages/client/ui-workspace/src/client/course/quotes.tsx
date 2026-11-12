/** Quote chips keep model provenance out of the learner's editing surface. */
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextRule, UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CourseId, CourseQuoteId } from '@deepseek-ai/dsh-util-course-document'

export interface CourseQuoteRef {
  readonly courseId: CourseId
  readonly quoteId: CourseQuoteId
  readonly path: string
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    coursequote: CourseQuoteRef & { readonly excerpt: string }
  }
}
/** Decode only the shape minted by the course quote owner. */
export function parseCourseQuoteRef(raw: string): CourseQuoteRef {
  const data: unknown = JSON.parse(raw)
  if (
    data === null ||
    typeof data !== 'object' ||
    !('courseId' in data) ||
    !('quoteId' in data) ||
    !('path' in data) ||
    typeof data.courseId !== 'string' ||
    typeof data.quoteId !== 'string' ||
    typeof data.path !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(data.courseId) ||
    !/^[0-9a-f-]{36}$/u.test(data.quoteId)
  )
    throw new Error('Invalid course quote reference')
  return { courseId: data.courseId as CourseId, quoteId: data.quoteId as CourseQuoteId, path: data.path }
}
/** A user-message renderer replays quote chips from durable model-visible text. */
export const courseQuoteRule: UserTextRule<'coursequote'> = {
  id: 'coursequote',
  order: 10,
  match(text, from) {
    const headers = /<course-quote (\{[^\n]+\})>\n/gu
    headers.lastIndex = from
    for (let match = headers.exec(text); match !== null; match = headers.exec(text)) {
      try {
        const ref = parseCourseQuoteRef(match[1] ?? '')
        const close = `\n</course-quote:${ref.quoteId}>`
        const end = text.indexOf(close, headers.lastIndex)
        if (end < 0) continue
        return {
          id: 'coursequote',
          start: match.index,
          end: end + close.length,
          data: { ...ref, excerpt: text.slice(headers.lastIndex, end) },
        }
      } catch {
        continue
      }
    }
    return undefined
  },
}
/** Render one durable source chip with a snapshot-aware preview action. */
export function CourseQuoteChip({
  node,
  interactive,
  openQuote,
  t,
}: UserTextNodeProps<'coursequote'> & PropsLocale<'course'> & { readonly openQuote: (ref: CourseQuoteRef) => void }) {
  return (
    <ReferenceChip
      appearance="file"
      label={t('quoteLabel') + ' · ' + node.data.path}
      title={node.data.excerpt.slice(0, 160)}
      {...(interactive
        ? {
          onActivate: () => {
            openQuote(node.data)
          },
        }
        : {})}
    />
  )
}
