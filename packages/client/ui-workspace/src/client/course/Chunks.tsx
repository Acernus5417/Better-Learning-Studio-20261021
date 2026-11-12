/** Progressive semantic chunks retain mounted content and never split source syntax. */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ReadingNode } from '@deepseek-ai/dsh-util-course-document'
import type { CourseMathQueue } from './Math.tsx'
import css from './workbench.module.css'

export interface ReadingChunk {
  readonly nodes: readonly ReadingNode[]
  readonly start: number
  readonly end: number
}
/** Lists, tables and disclosures remain indivisible; ordinary top-level blocks share a modest batch. */
export function courseReadingChunks(nodes: readonly ReadingNode[]): readonly ReadingChunk[] {
  const chunks: ReadingChunk[] = []
  let batch: ReadingNode[] = []
  const finish = (): void => {
    const first = batch[0],
      last = batch.at(-1)
    if (first === undefined || last === undefined) return
    chunks.push({ nodes: batch, start: first.start, end: last.end })
    batch = []
  }
  for (const node of nodes) {
    const first = batch[0]
    if (first !== undefined && (batch.length >= 20 || node.end - first.start > 8000)) finish()
    batch.push(node)
  }
  finish()
  return chunks
}
/** Prepared chunks keep their DOM. Near-viewport observation can prepare a later chunk ahead of background work. */
export const CourseChunk = memo(function CourseChunk({
  chunk,
  prepared,
  queue,
  render,
}: {
  readonly chunk: ReadingChunk
  readonly prepared: boolean
  readonly queue: CourseMathQueue
  readonly render: (node: ReadingNode) => ReactNode
}) {
  const mount = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(prepared)
  if (prepared && !ready) setReady(true)
  useEffect(() => {
    if (ready || mount.current === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setReady(true)
      return
    }
    return queue.observe(mount.current, () => {
      setReady(true)
    })
  }, [queue, ready])
  return (
    <div
      ref={mount}
      className={css.readingChunk}
      data-course-chunk-pending={!ready || undefined}
      data-course-chunk-start={chunk.start}
      aria-hidden={!ready || undefined}
      style={ready ? undefined : { minHeight: Math.max(120, ((chunk.end - chunk.start) / 60) * 29) }}
    >
      {ready
        ? chunk.nodes.map((node) => {
          const content = render(node)
          return content === null ? null : (
            <div key={`${node.start}:${node.end}:${node.type}`} className={css.readingBlock}>
              {content}
            </div>
          )
        })
        : null}
    </div>
  )
})
