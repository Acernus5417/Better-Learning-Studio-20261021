/** Shared, byte-bounded parsing cache with one off-thread task at a time. */
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { CourseFileContent } from '@deepseek-ai/dsh-util-course-document'

export interface CourseParsedFile {
  readonly file: CourseFileContent
  readonly reading: CourseFileContent
  readonly cost: number
}
interface Job {
  readonly id: number
  readonly course: string
  readonly path: string
  readonly text: string
  readonly indexOnly: boolean
  readonly resolve: (value: CourseParsedFile) => void
  readonly reject: (error: Error) => void
}
/** Metadata is a cache hint only; callers still freshly read before mutation or citation. */
export function courseFileStamp(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}
/** One library owns its parser, pending deduplication and a conservative 64 MiB LRU. */
export class CourseReadCache {
  private worker: Worker | undefined
  private current: Job | undefined
  private queue: Job[] = []
  private sequence = 0
  private closed = false
  private idle: ReturnType<typeof setTimeout> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private bytes = 0
  private entries = new Map<string, { stamp: string; value: CourseParsedFile; bytes: number }>()
  private pending = new Map<string, Promise<CourseParsedFile>>()
  private content = new Map<string, { document: CourseFileContent['document']; cost: number }>()
  private contentBytes = 0
  readonly metrics = { parses: 0, hits: 0, bytesRead: 0 }
  private assertOpen(): void {
    if (this.closed) throw new Error('Course parser is closed')
  }
  private start(): Worker {
    if (this.idle !== undefined) clearTimeout(this.idle)
    if (this.worker !== undefined) return this.worker
    let entry = new URL('./course-read-worker.js', import.meta.url)
    if (import.meta.url.endsWith('.ts')) {
      const bootstrap = `import {register} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(new URL('./course-read-worker.ts', import.meta.url).href)})`
      entry = new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
    }
    const worker = new Worker(entry, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 } })
    this.worker = worker
    worker.on('message', (value: unknown) => {
      const job = this.current
      if (job === undefined) return
      if (value === null || typeof value !== 'object' || !('id' in value) || value.id !== job.id || !('ok' in value)) {
        this.fail(new Error('Invalid course parser response'))
        return
      }
      this.current = undefined
      if (this.deadline !== undefined) clearTimeout(this.deadline)
      if (
        value.ok === true &&
        'file' in value &&
        'reading' in value &&
        isFile(value.file) &&
        isFile(value.reading) &&
        'cost' in value &&
        typeof value.cost === 'number' &&
        Number.isFinite(value.cost) &&
        value.cost >= 0
      ) {
        this.metrics.parses++
        job.resolve({ file: value.file, reading: value.reading, cost: value.cost })
      } else
        job.reject(
          new Error('error' in value && typeof value.error === 'string' ? value.error : 'Course parser failed'),
        )
      this.pump()
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.fail(error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(new Error(`Course parser exited (${code})`))
    })
    worker.unref()
    return worker
  }
  private fail(error: Error): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    if (this.deadline !== undefined) clearTimeout(this.deadline)
    const worker = this.worker
    this.worker = undefined
    this.current?.reject(error)
    this.current = undefined
    for (const job of this.queue) job.reject(error)
    this.queue = []
    if (worker !== undefined) void worker.terminate()
  }
  private pump(): void {
    if (this.current !== undefined || this.closed) return
    const job = this.queue.shift()
    if (job === undefined) {
      this.worker?.unref()
      this.idle = setTimeout(() => {
        if (this.current !== undefined) return
        const worker = this.worker
        this.worker = undefined
        if (worker !== undefined) void worker.terminate()
      }, 2000)
      this.idle.unref()
      return
    }
    try {
      const worker = this.start()
      this.current = job
      worker.ref()
      this.deadline = setTimeout(() => {
        this.fail(new Error('Course parsing timed out; reload to retry'))
      }, 30_000)
      this.deadline.unref()
      worker.postMessage({ id: job.id, course: job.course, path: job.path, text: job.text, indexOnly: job.indexOnly })
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)))
      this.fail(new Error('Cannot start course parser'))
    }
  }
  /** Parse a stable disk snapshot; same-file concurrent readers share the exact same task. */
  async read(
    course: string,
    path: string,
    target: string,
    presentationStamp: string,
    fresh = false,
    indexOnly = false,
    reuse?: (version: string, text: string) => CourseFileContent | undefined,
  ): Promise<CourseParsedFile> {
    this.assertOpen()
    const info = await lstat(target),
      stamp = courseFileStamp(info) + ':' + presentationStamp
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('Invalid course text file')
    const baseKey = course + '\0' + path
    const key = baseKey + (indexOnly ? '\0index' : '')
    const cachedKey = indexOnly && this.entries.get(baseKey)?.stamp === stamp ? baseKey : key
    const cached = this.entries.get(cachedKey)
    if (!fresh && cached?.stamp === stamp) {
      this.entries.delete(cachedKey)
      this.entries.set(cachedKey, cached)
      this.metrics.hits++
      return cached.value
    }
    const pendingKey = key + '\0' + stamp + (fresh ? ':fresh' : '')
    const existing = this.pending.get(pendingKey)
    if (existing !== undefined) return existing
    const run = (async () => {
      const text = await readFile(target, 'utf8')
      this.assertOpen()
      this.metrics.bytesRead += Buffer.byteLength(text)
      let value: CourseParsedFile | undefined
      if (indexOnly) {
        const version = createHash('sha256').update(text).digest('hex')
        const cachedContent = this.content.get(version)
        const file =
          cachedContent === undefined
            ? reuse?.(version, text)
            : { path, text, version, document: cachedContent.document }
        if (file !== undefined) {
          this.metrics.hits++
          value = { file, reading: file, cost: text.length * 4 + JSON.stringify(file.document).length * 4 }
        }
      }
      if (value === undefined) {
        if (this.queue.length >= 32) throw new Error('Course parser is busy; retry')
        value = await new Promise<CourseParsedFile>((resolve, reject) => {
          this.queue.push({ id: ++this.sequence, course, path, text, indexOnly, resolve, reject })
          this.pump()
        })
      }
      this.assertOpen()
      if (courseFileStamp(await lstat(target)) !== courseFileStamp(info))
        throw new Error('Document changed during reading; reload')
      if (indexOnly && !this.content.has(value.file.version)) {
        const cost = JSON.stringify(value.file.document).length * 4
        if (cost <= 16 * 1024 * 1024) {
          while (this.contentBytes + cost > 16 * 1024 * 1024) {
            const first = this.content.entries().next().value
            if (first === undefined) break
            this.content.delete(first[0])
            this.contentBytes -= first[1].cost
          }
          this.content.set(value.file.version, { document: value.file.document, cost })
          this.contentBytes += cost
        }
      }
      // Both trees share many nodes in memory; this deliberately overestimates their retained cost.
      const cost = value.cost
      const old = this.entries.get(key)
      if (old !== undefined) {
        this.bytes -= old.bytes
        this.entries.delete(key)
      }
      if (cost <= 64 * 1024 * 1024) {
        while (this.bytes + cost > 64 * 1024 * 1024) {
          const first = this.entries.entries().next().value
          if (first === undefined) break
          this.entries.delete(first[0])
          this.bytes -= first[1].bytes
        }
        this.entries.set(key, { stamp, value, bytes: cost })
        this.bytes += cost
      }
      return value
    })()
    this.pending.set(pendingKey, run)
    try {
      return await run
    } finally {
      this.pending.delete(pendingKey)
    }
  }
  /** Invalidate hints after a watcher or explicit reload; never interrupt admitted readers. */
  invalidate(course?: string, path?: string): void {
    const prefix = course === undefined ? undefined : course + '\0' + (path ?? '')
    for (const [key, entry] of this.entries)
      if (
        prefix === undefined ||
        (path === undefined
          ? key.startsWith(prefix)
          : key === prefix || key.startsWith(prefix + '\0') || key.startsWith(prefix + '/'))
      ) {
        this.entries.delete(key)
        this.bytes -= entry.bytes
      }
  }
  /** Reject outstanding work and release the owned Worker when the Host stops. */
  dispose(): void {
    this.closed = true
    this.fail(new Error('Course parser stopped'))
    this.invalidate()
    this.content.clear()
    this.contentBytes = 0
  }
}
function isFile(value: unknown): value is CourseFileContent {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'document' in value &&
    value.document !== null &&
    typeof value.document === 'object' &&
    'nodes' in value.document &&
    Array.isArray(value.document.nodes)
  )
}
