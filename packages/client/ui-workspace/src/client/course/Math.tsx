/** Course-owned cooperative formula preparation; mounted text and source ranges are never recycled. */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { renderTexToReact } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './workbench.module.css'

interface Work {
  readonly source: string
  readonly display: boolean
  readonly callbacks: Set<(value: ReactNode) => void>
}
/** One reader owns one observer, paint queue and bounded pure formula cache. */
export class CourseMathQueue {
  private frame: number | undefined
  private observer: IntersectionObserver | undefined
  private watched = new Map<Element, () => void>()
  private pending = new Map<string, Work>()
  private cached = new Map<string, { value: ReactNode; cost: number }>()
  private bytes = 0
  private disposed = false
  resume(): void {
    this.disposed = false
    if (this.pending.size > 0) this.schedule()
  }
  prepare(source: string, display: boolean, done: (value: ReactNode) => void): () => void {
    const key = (display ? 'block:' : 'inline:') + source
    const cache = this.cached.get(key)
    if (cache !== undefined) {
      this.cached.delete(key)
      this.cached.set(key, cache)
      done(cache.value)
      return () => {}
    }
    let work = this.pending.get(key)
    if (work === undefined) {
      work = { source, display, callbacks: new Set() }
      this.pending.set(key, work)
    }
    work.callbacks.add(done)
    this.schedule()
    const registered = work
    return () => {
      registered.callbacks.delete(done)
      if (registered.callbacks.size === 0 && this.pending.get(key) === registered) this.pending.delete(key)
    }
  }
  private runOne(): boolean {
    const first = this.pending.entries().next().value
    if (first === undefined) return false
    const [key, work] = first
    this.pending.delete(key)
    const value = renderTexToReact(work.source, work.display),
      cost = 1024 + work.source.length * 256
    if (cost <= 8 * 1024 * 1024) {
      while (this.cached.size >= 512 || this.bytes + cost > 8 * 1024 * 1024) {
        const old = this.cached.entries().next().value
        if (old === undefined) break
        this.cached.delete(old[0])
        this.bytes -= old[1].cost
      }
      this.cached.set(key, { value, cost })
      this.bytes += cost
    }
    for (const callback of work.callbacks) callback(value)
    return true
  }
  /** Native print needs complete math, including formulas that were never scrolled into view. */
  flush(): void {
    for (const [element, ready] of [...this.watched]) {
      this.watched.delete(element)
      this.observer?.unobserve(element)
      ready()
    }
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame)
      this.frame = undefined
    }
    while (this.runOne()) {
      /* Printing deliberately prepares the complete mounted document. */
    }
  }
  private schedule(): void {
    if (this.frame !== undefined || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      const end = performance.now() + 6
      do {
        if (!this.runOne()) break
      } while (performance.now() < end)
      if (this.pending.size > 0) this.schedule()
    })
  }
  observe(element: HTMLElement, ready: () => void): () => void {
    if (this.observer === undefined)
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) {
              const start = this.watched.get(entry.target)
              this.watched.delete(entry.target)
              this.observer?.unobserve(entry.target)
              start?.()
            }
        },
        { root: element.closest('[data-course-document]'), rootMargin: '1600px 0px' },
      )
    this.watched.set(element, ready)
    this.observer.observe(element)
    return () => {
      this.watched.delete(element)
      this.observer?.unobserve(element)
    }
  }
  dispose(): void {
    this.disposed = true
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.observer?.disconnect()
    this.pending.clear()
    this.watched.clear()
    this.cached.clear()
    this.bytes = 0
  }
}
/** Formula placeholders retain source text for selection/copy while expensive math waits near the viewport. */
export const CourseMath = memo(function CourseMath({
  source,
  display,
  start,
  end,
  queue,
  force,
}: {
  readonly source: string
  readonly display: boolean
  readonly start: number
  readonly end: number
  readonly queue: CourseMathQueue
  readonly force: boolean
}) {
  const mount = useRef<HTMLSpanElement>(null)
  const [result, setResult] = useState<{ source: string; display: boolean; value: ReactNode } | null>(() =>
    typeof IntersectionObserver === 'undefined' ? { source, display, value: renderTexToReact(source, display) } : null,
  )
  const ready = result !== null && result.source === source && result.display === display
  useEffect(() => {
    if (ready || mount.current === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setResult({ source, display, value: renderTexToReact(source, display) })
      return
    }
    let cancel = (): void => {}
    const run = (): void => {
      cancel = queue.prepare(source, display, (value) => {
        setResult({ source, display, value })
      })
    }
    const stop = force ? (run(), () => {}) : queue.observe(mount.current, run)
    return () => {
      stop()
      cancel()
    }
  }, [source, display, force, queue, ready])
  return (
    <span
      ref={mount}
      data-source-start={start}
      data-source-end={end}
      data-course-math-pending={!ready || undefined}
      data-course-math-display={display || undefined}
      className={!ready ? css.mathPending : undefined}
    >
      {!ready ? <span className={css.mathSource}>{source}</span> : result.value}
    </span>
  )
})
