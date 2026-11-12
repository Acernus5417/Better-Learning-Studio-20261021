/** Local course files, recoverable writes, course-scoped links and search. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename, lstat, realpath, access, rm } from 'node:fs/promises'
import { join, relative, dirname, extname, isAbsolute, sep } from 'node:path'
import { inspectCourseImport, copyCourseImport, type CourseImportPlan } from './course-import.ts'
import { CourseReadCache, courseFileStamp } from './course-read-cache.ts'
import { openCourseIndex, readIndexedDocument, readIndexedContent, writeIndexedDocument } from './course-index.ts'
import { CourseGraphIndex } from './course-graph-index.ts'
import { CourseReadBatch } from './course-read-batch.ts'
import {
  readGraphSnapshot,
  writeGraphSnapshot,
  parseGraphLayout,
  type CourseGraphSnapshot,
} from './course-graph-cache.ts'
import { resolveCourseLink, STUDY_MEDIA_TYPES, type StudyMediaType } from '@deepseek-ai/dsh-util-course-document'
import type {
  CourseGraphData,
  CourseGraphNote,
  CourseId,
  CourseRecord,
  CourseFile,
  CourseFileContent,
  CourseQuote,
  CourseQuoteId,
} from '@deepseek-ai/dsh-util-course-document'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const MAX_TEXT = 4 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_INDEX_TEXT = 64 * 1024 * 1024
const MAX_INDEX_DOCUMENTS = 2000
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
/** Public failures carry an HTTP status instead of silently overwriting work. */
export class CourseLibraryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}
/** Host composition supplies only the existing Workspace and Session APIs. */
export interface CourseSessionFactory {
  workspace(path: string, name: string): Promise<WorkspaceId>
  session(workspaceId: WorkspaceId, role: 'generation' | 'learning'): Promise<SessionId>
  sessionValid(sessionId: SessionId, workspaceId: WorkspaceId, role: 'generation' | 'learning'): Promise<boolean>
}
/** One catalog entry with the current file projection. */
export interface CourseOverview {
  readonly course: CourseRecord
  readonly files: readonly CourseFile[]
}
/** Immutable source plus whether its current path still holds that version. */
export interface SavedCourseQuote {
  readonly quote: CourseQuote
  readonly snapshot: string
  readonly current: boolean
}

/** Only managed direct children of the fixed root are addressable. */
export class CourseLibrary {
  private tail: Promise<unknown> = Promise.resolve()
  readonly reads = new CourseReadCache()
  private readonly indexJobs = new Map<string, Promise<unknown>>()
  private readonly graphIndexes = new Map<string, CourseGraphIndex>()
  private readonly graphSnapshots = new Map<string, CourseGraphSnapshot>()
  private readonly graphJobs = new Map<string, Promise<CourseGraphData>>()
  private readonly graphRevalidations = new Map<string, Promise<CourseGraphData>>()
  private readonly graphControllers = new Map<string, AbortController>()
  private readonly graphWarmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly graphWrites = new Map<string, Promise<void>>()
  private graphClosed = false
  private graphWarmTail: Promise<void> = Promise.resolve()
  /** Last completed graph read timings; nested file-system counts are per batch. */
  graphProfile:
    | {
      scanMs: number
      indexMs: number
      projectMs: number
      totalMs: number
      files: number
      parsed: number
      paths: number
      stats: number
      realpaths: number
      directoryHits: number
    }
    | undefined
  /** Release parser resources; derived on-disk indexes remain rebuildable. */
  dispose(): void {
    this.graphClosed = true
    for (const timer of this.graphWarmTimers.values()) clearTimeout(timer)
    for (const controller of this.graphControllers.values()) controller.abort()
    this.graphWarmTimers.clear()
    this.graphSnapshots.clear()
    this.graphRevalidations.clear()
    this.reads.dispose()
    this.graphIndexes.clear()
  }
  constructor(
    readonly root: string,
    private readonly sessions: CourseSessionFactory,
  ) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(run)
    this.tail = pending.catch(() => {})
    return pending
  }
  private async base(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    if ((await lstat(this.root)).isSymbolicLink()) throw new CourseLibraryError('Course root cannot be a symbolic link')
    return realpath(this.root)
  }
  private async folder(id: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new CourseLibraryError('Invalid course identity', 400)
    const path = join(await this.base(), id)
    if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
      throw new CourseLibraryError('Invalid course directory')
    return path
  }
  private async safe(id: string, path: string, allowMissing = false, batch?: CourseReadBatch): Promise<string> {
    const importedHidden =
      path.split('/').some(part => part.startsWith('.') && part !== '.' && part !== '..') &&
      (await this.manifest(id)).imported === true
    if (
      path === '' ||
      path.length > 1000 ||
      isAbsolute(path) ||
      /[\\:\x00-\x1f]/u.test(path) ||
      path
        .split('/')
        .some(
          p =>
            p === '' ||
            p === '.' ||
            p === '..' ||
            (p.startsWith('.') &&
              (!importedHidden || ['.studio', '.git', '.obsidian', '.betterlearning'].includes(p.toLowerCase()))) ||
            /[. ]$/u.test(p) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p),
        )
    )
      throw new CourseLibraryError('Invalid course-relative path', 400)
    const root = batch?.root ?? (await this.folder(id))
    if (batch !== undefined) batch.metrics.paths++
    let current = root
    for (const part of path.split('/')) {
      current = join(current, part)
      if (batch?.directories.has(current)) {
        batch.metrics.directoryHits++
        continue
      }
      try {
        const info = await lstat(current)
        if (batch !== undefined) batch.metrics.stats++
        if (info.isSymbolicLink()) throw new CourseLibraryError('Symbolic links cannot be followed')
        const actual = await realpath(current)
        if (batch !== undefined) batch.metrics.realpaths++
        const rel = relative(root, actual)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
          throw new CourseLibraryError('Path escapes course')
        if (batch !== undefined) {
          // A cached parent must not have been replaced by a redirect to another directory.
          if (relative(current, actual) !== '') throw new CourseLibraryError('Course path changed during graph reading')
          if (info.isDirectory()) batch.directories.add(current)
          batch.files.set(relative(root, current).split(sep).join('/'), { target: current, info })
        }
      } catch (error) {
        if (!allowMissing || !missing(error)) throw error
      }
    }
    return current
  }
  private async metadata(id: string, area = ''): Promise<string> {
    const root = await this.folder(id)
    let current = root
    for (const part of ['.studio', ...area.split('/').filter(Boolean)]) {
      current = join(current, part)
      await mkdir(current, { recursive: true })
      if ((await lstat(current)).isSymbolicLink()) throw new CourseLibraryError('Metadata cannot be a symbolic link')
    }
    return current
  }
  private async manifest(id: string): Promise<CourseRecord> {
    const path = join(await this.metadata(id), 'course.json')
    if ((await lstat(path)).isSymbolicLink()) throw new CourseLibraryError('Invalid manifest')
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !object(data) ||
      data.id !== id ||
      typeof data.name !== 'string' ||
      typeof data.createdAt !== 'string' ||
      typeof data.workspaceId !== 'string' ||
      (data.generationSessionId !== undefined && typeof data.generationSessionId !== 'string') ||
      (data.imported !== undefined && data.imported !== true) ||
      (data.learningSessionId !== undefined && typeof data.learningSessionId !== 'string')
    )
      throw new CourseLibraryError('Invalid course manifest')
    return {
      id: id as CourseId,
      name: data.name,
      createdAt: data.createdAt,
      workspaceId: data.workspaceId as WorkspaceId,
      ...(typeof data.generationSessionId === 'string'
        ? { generationSessionId: data.generationSessionId as SessionId }
        : {}),
      ...(data.imported === true ? { imported: true as const } : {}),
      ...(typeof data.learningSessionId === 'string' ? { learningSessionId: data.learningSessionId as SessionId } : {}),
    }
  }
  private async atomic(path: string, text: string | Uint8Array): Promise<void> {
    const temp = path + '.' + randomUUID() + '.tmp'
    await writeFile(temp, text, { flag: 'wx' })
    await rename(temp, path)
  }
  /** List managed courses only; never adopt a random external folder. */
  async list(): Promise<readonly CourseRecord[]> {
    await this.tail
    const root = await this.base()
    const result: CourseRecord[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue
      // A corrupt managed manifest is reported, not hidden as a missing course.
      result.push(await this.manifest(entry.name))
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  /** Allocate one fresh course directory and its Workspace before generation. */
  create(name: string): Promise<CourseRecord> {
    return this.serial(async () => {
      name = name.trim()
      if (name === '' || name.length > 120 || /[\x00-\x1f]/u.test(name))
        throw new CourseLibraryError('Course name is required (1–120 characters)', 400)
      const id = randomUUID() as CourseId
      const root = join(await this.base(), id)
      await mkdir(root)
      for (const folder of ['原始资料', '_工作区', '讲义', '笔记', '附件']) await mkdir(join(root, folder))
      const workspaceId = await this.sessions.workspace(root, name)
      const course: CourseRecord = { id, name, workspaceId, createdAt: new Date().toISOString() }
      await this.atomic(join(await this.metadata(id), 'course.json'), JSON.stringify(course, null, 2))
      // Obsidian-compatible settings are ordinary files; no external app is required.
      await mkdir(join(root, '.obsidian'))
      await writeFile(join(root, '.obsidian', 'app.json'), JSON.stringify({ alwaysUpdateLinks: true }))
      await writeFile(join(root, '课程首页.md'), `# ${name}\n\n课程资料与讲义保存在当前课程工作区中。\n`)

      return course
    })
  }
  /**
   * Inspect the chosen source folder without creating a Workspace or copying it.
   * @param path - Absolute user-selected directory.
   * @returns Source identity, Markdown count and file sizes.
   */
  async inspectImport(path: string): Promise<Omit<CourseImportPlan, 'files' | 'directories'>> {
    const plan = await inspectCourseImport(path, await this.base())
    return { source: plan.source, name: plan.name, markdown: plan.markdown, bytes: plan.bytes }
  }
  /**
   * Import an ordinary folder by copy, preserving layout and allocating fresh course identity.
   * @param source - User-selected absolute directory containing at least one .md file.
   * @returns The independent course; no source Session or private Studio metadata is adopted.
   */
  importCourse(source: string): Promise<CourseRecord> {
    return this.serial(async () => {
      const base = await this.base(),
        plan = await inspectCourseImport(source, base)
      const id = randomUUID() as CourseId,
        target = join(base, id),
        staging = join(base, '.import-' + id)
      await mkdir(staging)
      let published = false
      try {
        await copyCourseImport(plan, staging)
        await mkdir(join(staging, '_工作区'), { recursive: true })
        await rename(staging, target)
        published = true
        const workspaceId = await this.sessions.workspace(target, plan.name)
        const course: CourseRecord = {
          id,
          name: plan.name,
          workspaceId,
          createdAt: new Date().toISOString(),
          imported: true,
        }
        await this.atomic(join(await this.metadata(id), 'course.json'), JSON.stringify(course, null, 2))
        return course
      } catch (error) {
        const cleanup = published ? target : staging
        if (dirname(cleanup) !== base) throw new CourseLibraryError('Import cleanup left the course root')
        await rm(cleanup, { recursive: true, force: true })
        throw error
      }
    })
  }
  /** Generation and tutoring each retain their own durable Session. */
  session(id: string, role: 'generation' | 'learning'): Promise<{ sessionId: SessionId }> {
    return this.serial(async () => {
      const course = await this.manifest(id)
      const workspaceId = await this.sessions.workspace(await this.folder(id), course.name)
      const key = role === 'generation' ? 'generationSessionId' : 'learningSessionId'
      const existing = course[key]
      if (
        existing !== undefined &&
        workspaceId === course.workspaceId &&
        (await this.sessions.sessionValid(existing, workspaceId, role))
      )
        return { sessionId: existing }
      const sessionId = await this.sessions.session(workspaceId, role)
      const base: CourseRecord =
        workspaceId === course.workspaceId
          ? course
          : {
            id: course.id,
            name: course.name,
            createdAt: course.createdAt,
            workspaceId,
            ...(course.imported ? { imported: true as const } : {}),
          }
      if (existing !== undefined || workspaceId !== course.workspaceId)
        await writeFile(
          join(await this.metadata(id, 'learning/session-history'), randomUUID() + '.json'),
          JSON.stringify({ previous: course, reboundAt: new Date().toISOString(), role }),
          { flag: 'wx' },
        )
      await this.atomic(
        join(await this.metadata(id), 'course.json'),
        JSON.stringify({ ...base, [key]: sessionId }, null, 2),
      )
      return { sessionId }
    })
  }
  /** Rebuildable directory projection; private metadata and symlinks stay out. */
  async overview(id: string): Promise<CourseOverview> {
    const course = await this.manifest(id)
    const files: CourseFile[] = []
    const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 40) throw new CourseLibraryError('Course directory depth exceeds 40')
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (
          entry.isSymbolicLink() ||
          (entry.name.startsWith('.') &&
            (!course.imported ||
              ['.studio', '.git', '.obsidian', '.betterlearning'].includes(entry.name.toLowerCase())))
        )
          continue
        const path = prefix + entry.name
        const location = await this.safe(id, path)
        const info = await lstat(location)
        if (!info.isDirectory() && !info.isFile()) continue
        files.push({ path, directory: info.isDirectory(), bytes: info.size })
        if (files.length > MAX_FILES) throw new CourseLibraryError('Course contains more than 20000 files')
        if (info.isDirectory()) await visit(location, path + '/', depth + 1)
      }
    }
    await visit(await this.folder(id), '', 0)
    return { course, files: files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true })) }
  }
  private async graphScan(id: string, batch: CourseReadBatch, signal?: AbortSignal): Promise<CourseOverview> {
    const course = await this.manifest(id),
      files: CourseFile[] = []
    const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 40) throw new CourseLibraryError('Course directory depth exceeds 40')
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        signal?.throwIfAborted()
        if (
          entry.isSymbolicLink() ||
          entry.name.startsWith('.') ||
          entry.name === '_工作区' ||
          (!prefix && !course.imported && entry.name === '课程首页.md')
        )
          continue
        const path = prefix + entry.name
        const target = await this.safe(id, path, false, batch),
          admitted = batch.files.get(path)
        if (admitted === undefined || (!admitted.info.isDirectory() && !admitted.info.isFile())) continue
        files.push({ path, directory: admitted.info.isDirectory(), bytes: admitted.info.size })
        if (files.length > MAX_FILES) throw new CourseLibraryError('Course contains more than 20000 files')
        if (admitted.info.isDirectory()) await visit(target, path + '/', depth + 1)
      }
    }
    await visit(batch.root, '', 0)
    await batch.verify()
    return { course, files: files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true })) }
  }
  /** Read a bounded UTF-8 Markdown document and its exact content hash. */
  async read(id: string, path: string, fresh = false): Promise<CourseFileContent> {
    return (await this.parsed(id, path, fresh)).file
  }
  private async parsed(id: string, path: string, fresh = false) {
    const target = await this.safe(id, path)
    if (!['.md', '.markdown', '.txt'].includes(extname(path).toLowerCase()))
      throw new CourseLibraryError('This file is preview-only', 415)
    const info = await lstat(target)
    if (!info.isFile() || info.size > MAX_TEXT)
      throw new CourseLibraryError('Document exceeds the 4 MiB text limit', 413)
    const course = await this.folder(id)
    let presentationStamp = ''
    try {
      const metadata = join(course, '.betterlearning', 'presentation', hash(path) + '.json')
      const info = await lstat(metadata)
      presentationStamp = (info.isSymbolicLink() ? 'link:' : '') + courseFileStamp(info)
    } catch (error) {
      if (!missing(error)) presentationStamp = 'unavailable'
    }
    return this.reads.read(course, path, target, presentationStamp, fresh)
  }
  /** Conditional read projections avoid retransmitting unchanged source trees. */
  async view(
    action: string,
    id: string,
    path: string,
    known: string,
    signal?: AbortSignal,
  ): Promise<{ revision: string; value?: unknown }> {
    if (action === 'graph') return this.graphView(id, known, signal)
    let value: unknown, revision: string
    if (action === 'read') {
      const parsed = await this.parsed(id, path)
      value = { file: parsed.reading }
      revision = hash('reading-v1\0' + parsed.file.version + JSON.stringify(parsed.file.presentation ?? null))
    } else {
      if (action === 'list') value = { courses: await this.list() }
      else if (action === 'overview') value = await this.overview(id)
      else if (action === 'links')
        value = { links: (await this.links(id, signal)).filter(link => path === '' || link.path === path) }
      else if (action === 'search') value = { results: await this.search(id, path, signal) }
      else if (action === 'saved-quote') value = { savedQuote: await this.savedQuote(id, path) }
      else throw new CourseLibraryError('Unknown course view', 400)
      revision = hash(JSON.stringify(value))
    }
    signal?.throwIfAborted()
    return revision === known ? { revision } : { revision, value }
  }
  /** Stream-safe path for allowlisted local binary previews. */
  async asset(id: string, path: string, maxBytes = 64 * 1024 * 1024): Promise<{ data: Uint8Array; type: string }> {
    const types: Record<string, string> = {
      '.pdf': 'application/pdf',
      ...STUDY_MEDIA_TYPES,
    }
    const type = types[extname(path).toLowerCase()]
    if (type === undefined) throw new CourseLibraryError('Unsupported preview type', 415)
    const target = await this.safe(id, path)
    const info = await lstat(target)
    if (!info.isFile()) throw new CourseLibraryError('Preview requires a regular file', 400)
    if (info.size > maxBytes) throw new CourseLibraryError(`Preview exceeds ${maxBytes / (1024 * 1024)} MiB`, 413)
    return { data: await readFile(target), type }
  }

  /** Keep the exact bytes associated with a published frame. */
  async saveStudyMedia(id: string, data: Uint8Array, type: StudyMediaType): Promise<string> {
    const extension = Object.keys(STUDY_MEDIA_TYPES).find(ext => STUDY_MEDIA_TYPES[ext as keyof typeof STUDY_MEDIA_TYPES] === type)
    if (extension === undefined) throw new CourseLibraryError('Unsupported study media type', 415)
    const asset = createHash('sha256').update(data).digest('hex') + extension
    const target = join(await this.metadata(id, 'study-media'), asset)
    await this.atomic(target, data)
    return asset
  }

  async studyMedia(id: string, asset: string): Promise<{ data: Uint8Array; type: StudyMediaType }> {
    const extension = extname(asset)
    const type = STUDY_MEDIA_TYPES[extension as keyof typeof STUDY_MEDIA_TYPES]
    if (type === undefined || !/^[a-f0-9]{64}\.[a-z]+$/u.test(asset)) throw new CourseLibraryError('Invalid study media identity', 404)
    const target = join(await this.metadata(id, 'study-media'), asset)
    const info = await lstat(target)
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new CourseLibraryError('Invalid study media file', 404)
    return { data: await readFile(target), type }
  }
  /** CAS save plus durable before-image. A conflict never replaces disk content. */
  save(id: string, path: string, text: string, version: string): Promise<CourseFileContent> {
    return this.serial(async () => {
      if (Buffer.byteLength(text) > MAX_TEXT) throw new CourseLibraryError('Document too large', 413)
      const current = await this.read(id, path, true)
      if (current.version !== version)
        throw new CourseLibraryError('Document changed on disk. Reload or copy your draft before retrying.')
      const snapshots = await this.metadata(id, 'revisions')
      await writeFile(join(snapshots, current.version + '.md'), current.text, { flag: 'wx' }).catch(
        (error: unknown) => {
          if (!object(error) || error.code !== 'EEXIST') throw error
        },
      )
      await this.atomic(await this.safe(id, path), text)
      await this.markEdited(id, path)
      return this.read(id, path)
    })
  }
  private async markEdited(id: string, path: string): Promise<void> {
    await this.atomic(
      join(await this.metadata(id, 'learning'), 'revision-status.json'),
      JSON.stringify({ status: 'needs_review', path, editedAt: new Date().toISOString() }),
    )
  }
  /**
   * Append a reviewed selection to the source document's lazily allocated note.
   * Retries reuse the operation marker; name collisions never merge different documents.
   * @param id - Managed course identity.
   * @param sourcePath - Existing learning document, relative to this course.
   * @param body - Learner-reviewed Markdown.
   * @param operationId - Stable UUID retained across uncertain transport retries.
   * @param messageIds - Host-verified final answers selected by the learner.
   * @returns The note location and whether this write first created it.
   */
  appendNote(
    id: string,
    sourcePath: string,
    body: string,
    operationId: string,
    messageIds: readonly string[],
  ): Promise<{ path: string; created: boolean }> {
    return this.serial(async () => {
      await this.read(id, sourcePath, true)
      if (!/^[0-9a-f-]{36}$/iu.test(operationId) || body.trim() === '' || Buffer.byteLength(body) > 1024 * 1024)
        throw new CourseLibraryError('A nonempty note preview and valid operation identity are required', 400)
      const readOptional = async (path: string): Promise<string | undefined> => {
        try {
          const target = await this.safe(id, path)
          const info = await lstat(target)
          if (!info.isFile() || info.size > MAX_TEXT)
            throw new CourseLibraryError('The note is unavailable or exceeds 4 MiB', 413)
          return await readFile(target, 'utf8')
        } catch (error) {
          if (missing(error)) return undefined
          throw error
        }
      }
      const title =
        sourcePath
          .split('/')
          .at(-1)
          ?.replace(/\.(?:md|markdown|txt)$/iu, '') ?? ''
      const sourceTag = '<!-- BLS-NOTE-SOURCE:' + Buffer.from(sourcePath).toString('base64url') + ' -->'
      const base = '笔记/' + title + '-笔记'
      let path = base + '.md'
      let current = await readOptional(path)
      if (current !== undefined && !current.startsWith(sourceTag + '\n')) {
        path = base + '-' + hash(sourcePath).slice(0, 10) + '.md'
        current = await readOptional(path)
        if (current !== undefined && !current.startsWith(sourceTag + '\n'))
          throw new CourseLibraryError('The note name is already used by another document')
      }
      const operation = '<!-- BLS-NOTE-ENTRY:' + operationId + ':'
      const entryTag = operation + hash(body) + ' -->'
      if (current?.includes(operation)) {
        if (!current.includes(entryTag))
          throw new CourseLibraryError('This note operation was already saved with different text')
        return { path, created: false }
      }
      const created = current === undefined
      const previous =
        current ??
        sourceTag + '\n# ' + title + '-笔记\n\n来源：[[' + sourcePath.replace(/\.(?:md|markdown|txt)$/iu, '') + ']]\n'
      const entry =
        '\n\n' +
        entryTag +
        '\n<!-- BLS-NOTE-ANSWERS:' +
        Buffer.from(JSON.stringify(messageIds)).toString('base64url') +
        ' -->\n## ' +
        new Date().toISOString().replace('T', ' ').slice(0, 19) +
        '\n\n' +
        body.trim() +
        '\n'
      const text = previous.trimEnd() + entry
      if (Buffer.byteLength(text) > MAX_TEXT) throw new CourseLibraryError('The note exceeds the 4 MiB limit', 413)
      const target = await this.safe(id, path, true)
      await mkdir(dirname(target), { recursive: true })
      if (created) await writeFile(target, text, { flag: 'wx' })
      else {
        const snapshots = await this.metadata(id, 'revisions')
        await writeFile(join(snapshots, hash(previous) + '.md'), previous, { flag: 'wx' }).catch((error: unknown) => {
          if (!object(error) || error.code !== 'EEXIST') throw error
        })
        if ((await readOptional(path)) !== current)
          throw new CourseLibraryError('The note changed on disk; review it before retrying')
        await this.atomic(target, text)
      }
      return { path, created }
    })
  }
  /** File creation is exclusive; it never overwrites an existing generated artifact. */
  createFile(id: string, path: string, directory: boolean): Promise<void> {
    return this.serial(async () => {
      const target = await this.safe(id, path, true)
      await mkdir(dirname(target), { recursive: true })
      if (directory) await mkdir(target)
      else {
        if (!['.md', '.markdown', '.txt'].includes(extname(path).toLowerCase()))
          throw new CourseLibraryError('New documents must be Markdown or text', 400)
        await writeFile(target, '', { flag: 'wx' })
      }
    })
  }
  /** Deletion is a move to local trash with the original relative path recorded. */
  trash(id: string, path: string): Promise<void> {
    return this.serial(async () => {
      const target = await this.safe(id, path)
      const trash = await this.metadata(id, 'trash/' + randomUUID())
      await writeFile(join(trash, 'entry.json'), JSON.stringify({ path, deletedAt: new Date().toISOString() }))
      await rename(target, join(trash, 'content'))
      await this.markEdited(id, path)
    })
  }
  private async documents(id: string): Promise<CourseFileContent[]> {
    const { files } = await this.overview(id)
    const result: CourseFileContent[] = []
    let bytes = 0
    for (const file of files)
      if (!file.directory && /\.(?:md|markdown)$/iu.test(file.path) && file.bytes <= MAX_TEXT) {
        bytes += file.bytes
        if (bytes > MAX_INDEX_TEXT || result.length >= MAX_INDEX_DOCUMENTS) {
          throw new CourseLibraryError(
            'This basic index supports up to 2000 Markdown documents and 64 MiB of text. Individual files remain readable.',
            413,
          )
        }
        result.push(await this.read(id, file.path, true))
      }
    return result
  }
  private indexed(
    id: string,
    files: readonly CourseFile[],
    signal?: AbortSignal,
    complete = true,
    metadataOnly = false,
    batch?: CourseReadBatch,
  ): Promise<CourseFileContent[]> {
    const run = (async () => {
      await this.indexJobs.get(id)
      signal?.throwIfAborted()
      const db = await openCourseIndex(join(await this.metadata(id, 'index'), 'course.sqlite'))
      try {
        const documents: CourseFileContent[] = [],
          changed: { stamp: string; file: CourseFileContent }[] = []
        let bytes = 0
        for (const file of files) {
          if (file.directory || !/\.(?:md|markdown)$/iu.test(file.path) || file.bytes > MAX_TEXT) continue
          bytes += file.bytes
          if (bytes > MAX_INDEX_TEXT || documents.length >= MAX_INDEX_DOCUMENTS)
            throw new CourseLibraryError('Course index text limit exceeded', 413)
          signal?.throwIfAborted()
          const admitted = batch?.files.get(file.path)
          const target = admitted?.target ?? (await this.safe(id, file.path))
          let stamp = courseFileStamp(admitted?.info ?? (await lstat(target)))
          let document = readIndexedDocument(db, file.path, stamp, metadataOnly)
          if (document === undefined) {
            if (batch !== undefined) {
              await batch.verify()
              await this.safe(id, file.path, false, batch)
              const current = batch.files.get(file.path)
              if (current === undefined) throw new CourseLibraryError('Course file disappeared during graph reading')
              stamp = courseFileStamp(current.info)
            }
            const parsed = (
              await this.reads.read(
                batch?.root ?? (await this.folder(id)),
                file.path,
                target,
                '',
                false,
                true,
                (version, text) => readIndexedContent(db, version, file.path, text),
              )
            ).file
            signal?.throwIfAborted()
            if (batch !== undefined) await this.safe(id, file.path, false, batch)
            if (stamp !== courseFileStamp(await lstat(target)))
              throw new CourseLibraryError('Course changed during indexing; refresh')
            document = { ...parsed, document: { ...parsed.document, nodes: [] } }
            changed.push({ stamp, file: document })
          }
          documents.push(document)
        }
        const live = new Set(documents.map(document => document.path))
        const removed = complete
          ? db
            .prepare('SELECT path FROM documents')
            .all()
            .map(row => String(row.path))
            .filter(path => !live.has(path))
          : []
        if (changed.length > 0 || removed.length > 0) {
          db.exec('BEGIN')
          try {
            for (const row of changed) writeIndexedDocument(db, row.stamp, row.file)
            for (const path of removed) {
              db.prepare('DELETE FROM documents WHERE path=?').run(path)
              db.prepare('DELETE FROM search WHERE path=?').run(path)
            }
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
        return documents
      } finally {
        db.close()
      }
    })()
    const settled = run.then(
      () => {},
      () => {},
    )
    this.indexJobs.set(id, settled)
    void settled.then(() => {
      if (this.indexJobs.get(id) === settled) this.indexJobs.delete(id)
    })
    return run
  }
  /**
   * Project one course into graph metadata, excluding private work and foreign course data.
   * @param id - Admitted managed course identity.
   * @returns Timestamps, tags and local destinations without document bodies or Sessions.
   */
  private async buildGraph(id: string, signal?: AbortSignal): Promise<CourseGraphData> {
    const started = performance.now(),
      parses = this.reads.metrics.parses
    const batch = await CourseReadBatch.create(await this.folder(id))
    const overview = await this.graphScan(id, batch, signal),
      scanned = performance.now()
    const files = overview.files.filter(
      file =>
        !file.directory &&
        !file.path.split('/').some(part => part.startsWith('.') || part === '_工作区') &&
        (overview.course.imported === true || file.path !== '课程首页.md'),
    )
    const indexed = new Map(
      (await this.indexed(id, files, signal, false, true, batch)).map(file => [file.path, file]),
    )
    const indexedAt = performance.now()
    const paths = files.map(file => file.path),
      notes: CourseGraphNote[] = []
    const graphIndex = this.graphIndexes.get(id) ?? new CourseGraphIndex()
    this.graphIndexes.delete(id)
    this.graphIndexes.set(id, graphIndex)
    if (this.graphIndexes.size > 8) {
      const oldest = this.graphIndexes.keys().next().value
      if (oldest !== undefined) this.graphIndexes.delete(oldest)
    }
    graphIndex.updateInventory(paths, [...indexed.values()])
    let bytes = 0,
      documents = 0,
      linkCount = 0
    for (const file of files) {
      signal?.throwIfAborted()
      const isAttachment = !/\.(?:md|markdown)$/iu.test(file.path)
      const info = batch.files.get(file.path)?.info
      if (info === undefined) throw new CourseLibraryError('Course graph file was not admitted')
      if (isAttachment) {
        notes.push({
          path: file.path,
          links: [],
          tags: [],
          ctime: Math.min(info.birthtimeMs, info.mtimeMs),
          isAttachment,
        })
        continue
      }
      bytes += file.bytes
      documents++
      if (file.bytes > MAX_TEXT || bytes > MAX_INDEX_TEXT || documents > MAX_INDEX_DOCUMENTS)
        throw new CourseLibraryError('Course graph text limit exceeded', 413)
      const document = indexed.get(file.path)
      if (document === undefined) throw new CourseLibraryError('Course graph index is incomplete')
      const { links, tags } = graphIndex.project(document)
      linkCount += links.length + tags.length
      if (linkCount > 50_000) throw new CourseLibraryError('Course graph link limit exceeded', 413)
      notes.push({
        path: file.path,
        links,
        tags,
        ctime: Math.min(info.birthtimeMs, info.mtimeMs),
        isAttachment,
      })
    }
    await batch.verify()
    const ended = performance.now()
    this.graphProfile = {
      scanMs: scanned - started,
      indexMs: indexedAt - scanned,
      projectMs: ended - indexedAt,
      totalMs: ended - started,
      files: files.length,
      parsed: this.reads.metrics.parses - parses,
      ...batch.metrics,
    }
    const referenced = new Set(
      notes.flatMap(note => note.links.filter(link => link.resolved).map(link => link.target)),
    )
    const visible = notes.filter(note => !note.isAttachment || referenced.has(note.path))
    if (visible.length > 5000) throw new CourseLibraryError('Course graph supports up to 5000 files', 413)
    return { notes: visible }
  }
  private retainGraph(snapshot: CourseGraphSnapshot): void {
    this.graphSnapshots.delete(snapshot.courseId)
    this.graphSnapshots.set(snapshot.courseId, snapshot)
    while (this.graphSnapshots.size > 8) {
      const oldest = this.graphSnapshots.keys().next().value
      if (oldest === undefined) break
      this.graphSnapshots.delete(oldest)
    }
  }
  private storeGraph(snapshot: CourseGraphSnapshot): Promise<void> {
    const id = snapshot.courseId
    const pending = (this.graphWrites.get(id) ?? Promise.resolve())
      .then(async () => {
        if (this.graphClosed) return
        await writeGraphSnapshot(await this.metadata(id, 'index'), snapshot)
      })
      .catch((error: unknown) => {
        console.warn(
          'course graph: derived snapshot was not saved',
          error instanceof Error ? error.name : 'invalid data',
        )
      })
    this.graphWrites.set(id, pending)
    void pending.finally(() => {
      if (this.graphWrites.get(id) === pending) this.graphWrites.delete(id)
    })
    return pending
  }
  /**
   * Build verified graph metadata once per course.
   * @param id - Managed course identity.
   * @param signal - Calling view cancellation; background indexing remains library-owned.
   * @returns Verified course-local relationships.
   */
  async graph(id: string, signal?: AbortSignal): Promise<CourseGraphData> {
    signal?.throwIfAborted()
    if (this.graphClosed) throw new CourseLibraryError('Course graph owner stopped')
    const existing = this.graphJobs.get(id)
    if (existing !== undefined) return existing
    const controller = new AbortController()
    this.graphControllers.set(id, controller)
    const run = (async () => {
      const graph = await this.buildGraph(id, controller.signal)
      controller.signal.throwIfAborted()
      const revision = hash(JSON.stringify(graph)),
        previous = this.graphSnapshots.get(id)
      const snapshot: CourseGraphSnapshot = {
        schema: 2,
        courseId: id,
        revision,
        graph,
        ...(previous?.layout === undefined ? {} : { layout: previous.layout }),
      }
      this.retainGraph(snapshot)
      if (previous?.revision !== revision) await this.storeGraph(snapshot)
      return graph
    })()
    this.graphJobs.set(id, run)
    try {
      const graph = await run
      signal?.throwIfAborted()
      return graph
    } finally {
      if (this.graphJobs.get(id) === run) this.graphJobs.delete(id)
      if (this.graphControllers.get(id) === controller) this.graphControllers.delete(id)
    }
  }
  private async graphView(
    id: string,
    known: string,
    signal?: AbortSignal,
  ): Promise<{ revision: string; value?: unknown }> {
    signal?.throwIfAborted()
    // Admission is repeated per request; cached source metadata is explicitly provisional.
    const directory = await this.metadata(id, 'index')
    if (known === '') {
      const disk = await readGraphSnapshot(directory, id)
      const stored = this.graphSnapshots.get(id) ?? disk
      if (stored !== undefined) {
        this.retainGraph(stored)
        const pending = this.graph(id)
        this.graphRevalidations.set(id, pending)
        while (this.graphRevalidations.size > 8) {
          const oldest = this.graphRevalidations.keys().next().value
          if (oldest === undefined) break
          this.graphRevalidations.delete(oldest)
        }
        void pending.catch(() => {}) // the next conditional request reports the failure
        return {
          revision: 'pending:' + stored.revision,
          value: {
            graph: stored.graph,
            graphRevision: stored.revision,
            graphPending: true,
            ...(stored.layout === undefined ? {} : { graphLayout: stored.layout }),
          },
        }
      }
    }
    const pending = known.startsWith('pending:') ? this.graphRevalidations.get(id) : undefined
    const graph = await (pending ?? this.graph(id, signal))
    if (pending !== undefined && this.graphRevalidations.get(id) === pending) this.graphRevalidations.delete(id)
    signal?.throwIfAborted()
    const snapshot = this.graphSnapshots.get(id),
      revision = snapshot?.revision ?? hash(JSON.stringify(graph))
    return revision === known
      ? { revision }
      : {
        revision,
        value: {
          graph,
          graphRevision: revision,
          ...(snapshot?.layout === undefined ? {} : { graphLayout: snapshot.layout }),
        },
      }
  }
  /** Coalesce background indexing. @param id - Managed course identity. @param delay - Quiet period in milliseconds. */
  scheduleGraph(id: string, delay = 2000): void {
    if (this.graphClosed || !/^[0-9a-f-]{36}$/u.test(id)) return
    const previous = this.graphWarmTimers.get(id)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.graphWarmTimers.delete(id)
      this.graphWarmTail = this.graphWarmTail
        .then(async () => {
          // A watcher batch may describe writes that preceded an active user request.
          // Finish that admitted read, then verify once more instead of failing its caller.
          await this.graphJobs.get(id)?.catch(() => {})
          if (!this.graphClosed) await this.graph(id)
        })
        .catch((error: unknown) => {
          if (!this.graphClosed && !(error instanceof Error && error.name === 'AbortError'))
            console.warn(
              'course graph: background indexing deferred',
              error instanceof Error ? error.name : 'invalid data',
            )
        })
    }, delay)
    timer.unref()
    this.graphWarmTimers.set(id, timer)
  }
  /** Save layout hints. @param id - Managed course identity. @param input - Untrusted, bounded file coordinates. */
  async saveGraphLayout(id: string, input: unknown): Promise<void> {
    const layout = parseGraphLayout(input),
      directory = await this.metadata(id, 'index')
    const current = this.graphSnapshots.get(id) ?? (await readGraphSnapshot(directory, id))
    if (current === undefined || this.graphClosed) return
    const paths = new Set(current.graph.notes.map(note => note.path))
    const positions = new Map(
      (current.layout?.positions ?? []).filter(point => paths.has(point.path)).map(point => [point.path, point]),
    )
    for (const point of layout.positions) if (paths.has(point.path)) positions.set(point.path, point)
    const snapshot: CourseGraphSnapshot = { ...current, layout: { ...layout, positions: [...positions.values()] } }
    this.retainGraph(snapshot)
    await this.storeGraph(snapshot)
  }
  /** Return explicit resolved, ambiguous and missing destinations for each link. */
  async links(
    id: string,
    signal?: AbortSignal,
  ): Promise<
    readonly {
      from: string
      target: string
      anchor: string
      path?: string
      ambiguous: readonly string[]
      embed: boolean
    }[]
  > {
    const files = (await this.overview(id)).files
    const documents = await this.indexed(id, files, signal)
    const paths = files.filter(f => !f.directory).map(f => f.path)
    return documents.flatMap(doc =>
      doc.document.links.map(link => ({
        from: doc.path,
        target: link.target,
        anchor: link.anchor,
        embed: link.embed,
        ...resolveCourseLink(doc.path, link.target, paths, link.wiki),
      })),
    )
  }
  /** Preview and execute the same CAS-guarded rename plan; backups permit recovery. */
  renameFile(
    id: string,
    from: string,
    to: string,
    commit: boolean,
    expected?: string,
  ): Promise<{ token: string; affected: readonly string[] }> {
    return this.serial(async () => {
      const source = await this.safe(id, from)
      const destination = await this.safe(id, to, true)
      if ((await lstat(source)).isDirectory())
        throw new CourseLibraryError('Rename documents individually; directory moves are deferred', 400)
      try {
        await access(destination)
        throw new CourseLibraryError('Destination already exists')
      } catch (error) {
        if (!missing(error)) throw error
      }
      const docs = await this.documents(id)
      const paths = (await this.overview(id)).files.filter(f => !f.directory).map(f => f.path)
      const writes: { path: string; text: string; before: string; version: string }[] = []
      const newPaths = paths.map(path => (path === from ? to : path))
      for (const doc of docs) {
        let text = doc.text
        const sourceAfter = doc.path === from ? to : doc.path
        for (const link of [...doc.document.links].sort((a, b) => b.start - a.start)) {
          const resolved = resolveCourseLink(doc.path, link.target, paths, link.wiki).path
          if (resolved === undefined || (resolved !== from && doc.path !== from)) continue
          const targetAfter = resolved === from ? to : resolved
          if (resolveCourseLink(sourceAfter, link.target, newPaths, link.wiki).path === targetAfter) continue
          let target = relative(dirname(sourceAfter), targetAfter).replaceAll('\\', '/')
          // Wiki destinations are vault-root paths; standard Markdown is relative.
          if (link.wiki) target = targetAfter.replace(/\.md$/iu, '')
          else
            target = target
              .split('/')
              .map(segment => encodeURIComponent(segment))
              .join('/')
          text = text.slice(0, link.start) + target + text.slice(link.end)
        }
        if (text !== doc.text) writes.push({ path: doc.path, text, before: doc.text, version: doc.version })
      }
      const token = hash(
        JSON.stringify({
          from,
          to,
          sourceHash: hash(await readFile(source, 'utf8')),
          writes: writes.map(w => [w.path, w.version, w.text]),
        }),
      )
      if (commit) {
        if (expected !== token)
          throw new CourseLibraryError('Rename preview is stale; inspect the affected files again')
        const journal = await this.metadata(id, 'revisions/rename-' + randomUUID())
        await writeFile(join(journal, 'plan.json'), JSON.stringify({ from, to, writes, status: 'prepared' }, null, 2))
        for (const item of writes)
          if ((await this.read(id, item.path, true)).version !== item.version)
            throw new CourseLibraryError('A linked document changed during rename')
        // Each replacement is atomic. A journal retains every before-image if
        // an external writer or a process interruption prevents full completion.
        await mkdir(dirname(destination), { recursive: true })
        await rename(source, destination)
        for (const item of writes)
          await this.atomic(await this.safe(id, item.path === from ? to : item.path), item.text)
        await writeFile(join(journal, 'complete.json'), JSON.stringify({ completedAt: new Date().toISOString() }))
        await this.markEdited(id, to)
      }
      return { token, affected: writes.map(item => item.path) }
    })
  }
  /** SQLite's trigram MATCH handles >=3 code points; instr handles short CJK literally. */
  async search(id: string, query: string, signal?: AbortSignal): Promise<readonly { path: string; excerpt: string }[]> {
    if (query.trim() === '' || query.length > 200) return []
    const docs = await this.indexed(id, (await this.overview(id)).files, signal)
    const allowed = new Set(docs.map(doc => doc.path))
    const db = await openCourseIndex(join(await this.metadata(id, 'index'), 'course.sqlite'))
    try {
      const rows =
        Array.from(query).length >= 3
          ? db
            .prepare('SELECT path, body FROM search WHERE search MATCH ?')
            .all('"' + query.replaceAll('"', '""') + '"')
          : db
            .prepare(
              'SELECT path, body FROM search WHERE instr(lower(body),lower(?))>0 OR instr(lower(path),lower(?))>0',
            )
            .all(query, query)
      return rows
        .filter(row => allowed.has(String(row.path)))
        .slice(0, 100)
        .map((row) => {
          const body = String(row.body)
          const at = Math.max(0, body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()))
          return { path: String(row.path), excerpt: body.slice(Math.max(0, at - 60), at + 180) }
        })
    } finally {
      db.close()
    }
  }
  /** Persist a source-verified quote before exposing it to the learning Session. */
  quote(id: string, path: string, version: string, start: number, end: number): Promise<CourseQuote> {
    return this.serial(async () => {
      const doc = await this.read(id, path, true)
      if (doc.version !== version)
        throw new CourseLibraryError('Selection is stale. Reload the document and select again.')
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > doc.text.length ||
        end - start > 24_000
      )
        throw new CourseLibraryError('Invalid or oversized selection', 400)
      const quote: CourseQuote = {
        id: randomUUID() as CourseQuoteId,
        courseId: id as CourseId,
        path,
        version,
        start,
        end,
        text: doc.text.slice(start, end),
        createdAt: new Date().toISOString(),
      }
      await writeFile(join(await this.metadata(id, 'learning/sources'), version + '.md'), doc.text, {
        flag: 'wx',
      }).catch((error: unknown) => {
        if (!object(error) || error.code !== 'EEXIST') throw error
      })
      await writeFile(
        join(await this.metadata(id, 'learning/quotes'), quote.id + '.json'),
        JSON.stringify(quote, null, 2),
        { flag: 'wx' },
      )
      return quote
    })
  }
  /** Read an immutable quote even after its source was edited, renamed or removed. */
  async savedQuote(id: string, quoteId: string): Promise<SavedCourseQuote> {
    if (!/^[0-9a-f-]{36}$/u.test(quoteId)) throw new CourseLibraryError('Invalid quote identity', 400)
    const path = join(await this.metadata(id, 'learning/quotes'), quoteId + '.json')
    if ((await lstat(path)).isSymbolicLink()) throw new CourseLibraryError('Invalid quote record')
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !object(data) ||
      data.courseId !== id ||
      data.id !== quoteId ||
      typeof data.path !== 'string' ||
      typeof data.version !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(data.version) ||
      typeof data.text !== 'string' ||
      typeof data.start !== 'number' ||
      typeof data.end !== 'number' ||
      typeof data.createdAt !== 'string'
    )
      throw new CourseLibraryError('Invalid saved quote')
    const source = join(await this.metadata(id, 'learning/sources'), data.version + '.md')
    if ((await lstat(source)).isSymbolicLink()) throw new CourseLibraryError('Invalid quote source')
    const snapshot = await readFile(source, 'utf8')
    if (
      hash(snapshot) !== data.version ||
      !Number.isInteger(data.start) ||
      !Number.isInteger(data.end) ||
      data.start < 0 ||
      data.end <= data.start ||
      data.end > snapshot.length ||
      snapshot.slice(data.start, data.end) !== data.text
    )
      throw new CourseLibraryError('Quote snapshot does not match its recorded version')
    let current = false
    try {
      current = (await this.read(id, data.path)).version === data.version
    } catch (error) {
      if (!missing(error)) throw error
    }
    return {
      quote: {
        id: quoteId as CourseQuoteId,
        courseId: id as CourseId,
        path: data.path,
        version: data.version,
        text: data.text,
        start: data.start,
        end: data.end,
        createdAt: data.createdAt,
      },
      snapshot,
      current,
    }
  }
}
