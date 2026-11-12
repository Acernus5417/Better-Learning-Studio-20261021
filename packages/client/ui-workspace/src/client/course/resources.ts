/** One resource owner handles authenticated reads, refresh and Session lifetimes. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CourseRecord, CourseFile, CourseFileContent, CourseQuote } from '@deepseek-ai/dsh-util-course-document'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** One course-local link projection. */
export interface CourseLinkRow {
  readonly from: string
  readonly target: string
  readonly anchor: string
  readonly path?: string
  readonly ambiguous: readonly string[]
  readonly embed: boolean
}
/** Resource-owned course catalog or document projection. */
export interface CourseData {
  readonly courses?: readonly CourseRecord[]
  readonly course?: CourseRecord
  readonly files?: readonly CourseFile[]
  readonly file?: CourseFileContent
  readonly graph?: import('@deepseek-ai/dsh-util-course-document').CourseGraphData
  readonly graphRevision?: string
  readonly graphPending?: true
  readonly graphLayout?: import('@deepseek-ai/dsh-util-course-document').CourseGraphLayout
  readonly links?: readonly CourseLinkRow[]
  readonly results?: readonly { path: string; excerpt: string }[]
  readonly savedQuote?: { readonly quote: CourseQuote; readonly snapshot: string; readonly current: boolean }
}
/** Conservative retained-data estimate, including paths and edges rather than source bytes alone. */
function snapshotCost(value: CourseData): number {
  if (value.file !== undefined) return value.file.text.length * 64
  let bytes = 1024
  for (const file of value.files ?? []) bytes += file.path.length * 2 + 128
  for (const course of value.courses ?? []) bytes += course.name.length * 2 + 512
  for (const note of value.graph?.notes ?? []) {
    bytes += note.path.length * 2 + 128
    for (const tag of note.tags) bytes += tag.length * 2 + 32
    for (const link of note.links) bytes += link.target.length * 2 + 128
  }
  for (const point of value.graphLayout?.positions ?? []) bytes += point.path.length * 2 + 128
  for (const link of value.links ?? [])
    bytes +=
      (link.from.length +
        link.target.length +
        link.anchor.length +
        (link.path?.length ?? 0) +
        link.ambiguous.join('').length) *
        2 +
      256
  for (const result of value.results ?? []) bytes += (result.path.length + result.excerpt.length) * 2 + 128
  if (value.savedQuote !== undefined)
    bytes += value.savedQuote.snapshot.length * 2 + value.savedQuote.quote.text.length * 2 + 1024
  return bytes
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    coursework: CourseData
    coursechat: { readonly reference: SessionReference }
  }
}
/**
 * Build a resource address without changing file syntax.
 * @param action - Course API read action.
 * @param id - Course identity.
 * @param path - Relative file path or action-specific argument.
 * @returns An encoded resource address.
 */
export function courseAddress(action: string, id = '', path = ''): string {
  return `dsh-resource://coursework/view?action=${encodeURIComponent(action)}&id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`
}
/** Structured Host failure with an optional action code for localized reports. */
export class CourseRequestError extends Error {
  /** @param message - Host error detail. @param code - Stable action failure code. */
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'CourseRequestError'
  }
}
/**
 * Use authenticated same-origin transport without browser API keys.
 * @param input - Course API request fields.
 * @param signal - Optional request cancellation.
 * @returns The typed successful response.
 */
export async function courseRequest<T>(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/better-learning/courses', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  })
  const data: unknown = await response.json()
  if (!response.ok)
    throw new CourseRequestError(
      typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : String(response.status),
      typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string'
        ? data.code
        : undefined,
    )
  return data as T
}
/**
 * Own course-resource refresh and Session lifetimes.
 * @param ctx - Client context providing Sessions.
 * @returns Data and chat providers plus their invalidation action.
 */
export function courseResourceOwner(ctx: Context): {
  data: ResourceProvider<'coursework'>
  chat: ResourceProvider<'coursechat'>
  refresh: () => void
} {
  const listeners = new Set<() => void>()
  const snapshots = new Map<string, { revision: string; value: CourseData; cost: number }>()
  let retainedBytes = 0
  return {
    refresh: () => {
      for (const listener of listeners) listener()
    },
    data: {
      protocol: 'coursework',
      async *open(address, { signal }) {
        const aborted = (): boolean => signal.aborted
        const url = new URL(address)
        const action = url.searchParams.get('action') ?? 'list'
        const id = url.searchParams.get('id') ?? ''
        const path = url.searchParams.get('path') ?? ''
        if (
          action !== 'list' &&
          (id === '' ||
            (action === 'read' && !/\.(?:md|markdown|txt)$/iu.test(path)) ||
            (action === 'saved-quote' && path === ''))
        ) {
          yield { ok: true, value: {} }
          return
        }
        let wake = (): void => {}
        let invalidated = false
        const isInvalidated = (): boolean => invalidated
        let cached = snapshots.get(address)
        let previous = cached?.revision ?? ''
        let delivered = false
        const changed = (): void => {
          invalidated = true
          wake()
        }
        listeners.add(changed)
        signal.addEventListener('abort', changed)
        try {
          while (!aborted()) {
            invalidated = false
            let refreshImmediately = false
            try {
              const packet = await courseRequest<{ revision: string; value?: CourseData }>(
                { action: 'view', kind: action, id, path, known: previous },
                signal,
              )
              if (aborted()) break
              if (isInvalidated()) continue
              if (packet.value !== undefined) {
                const value = packet.value
                refreshImmediately = value.graphPending === true
                const cost = snapshotCost(value)
                const old = snapshots.get(address)
                if (old !== undefined) {
                  retainedBytes -= old.cost
                  snapshots.delete(address)
                }
                cached = { revision: packet.revision, value, cost }
                if (cost <= 64 * 1024 * 1024) {
                  while (retainedBytes + cost > 64 * 1024 * 1024 || snapshots.size >= 32) {
                    const first = snapshots.entries().next().value
                    if (first === undefined) break
                    retainedBytes -= first[1].cost
                    snapshots.delete(first[0])
                  }
                  snapshots.set(address, cached)
                  retainedBytes += cost
                }
                previous = packet.revision
                delivered = true
                yield { ok: true, value }
              } else if (!delivered && cached !== undefined) {
                delivered = true
                yield { ok: true, value: cached.value }
              }
            } catch (error) {
              previous = ''
              if (!aborted())
                yield {
                  ok: false,
                  error: new RemoteError(
                    'gateway/internal',
                    error instanceof Error ? error.message : String(error),
                    {},
                  ),
                }
            }
            if (aborted()) break
            if (!isInvalidated() && !refreshImmediately)
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 5000)
                wake = () => {
                  clearTimeout(timer)
                  resolve()
                }
                if (aborted() || isInvalidated()) wake()
              })
          }
        } finally {
          listeners.delete(changed)
          signal.removeEventListener('abort', changed)
          wake()
        }
      },
    },
    chat: {
      protocol: 'coursechat',
      async *open(address, { signal }) {
        const aborted = (): boolean => signal.aborted
        const sessionId = new URL(address).searchParams.get('session')
        if (sessionId === null || sessionId === '') return
        const reference = ctx.sessions.retain(sessionId as SessionId, { source: 'workspaceOperation', signal })
        try {
          yield { ok: true, value: { reference } }
          if (!aborted())
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve()
                },
                { once: true },
              )
              if (aborted()) resolve()
            })
        } finally {
          reference.release()
        }
      },
    },
  }
}
