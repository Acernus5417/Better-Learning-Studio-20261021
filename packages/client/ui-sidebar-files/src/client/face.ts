/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's workspace-relative path as well,
 * which the tree has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Read the skill's durable course state for the compact desktop status strip. */
  readonly readCourseProgress: (sessionId: SessionId, root: string, signal: AbortSignal) => Promise<CourseProgressResult>
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/** Only the fields needed to display course-wide status. */
export interface CourseProgressState {
  readonly stage: string
  readonly completedChapters: number
  readonly completedLessons: number
  readonly blockers: number
  readonly nextAction: string | undefined
  readonly completedStages?: number
  readonly fontWarnings?: number
}

/** Course status, including pending, unavailable and ambiguous course roots. */
export type CourseProgressResult =
  | { readonly kind: 'waiting' | 'failed' | 'multiple' }
  | { readonly kind: 'ready'; readonly value: CourseProgressState }

/**
 * Read native workflow state when present, retaining legacy course progress for existing runs.
 * @param remote - workspace file access scoped to the requesting Session.
 * @returns A reader that resolves the course and its last saved progress.
 */
export function createCourseProgressReader(remote: ClientRemote): FilesInjected['readCourseProgress'] {
  return async (sessionId, root, signal) => {
    const readAt = async (prefix: string): Promise<CourseProgressResult | null> => {
      const native = await remote.workspaceFiles.read(sessionId, `${prefix}_工作区/内置工作流.json`, {}, signal)
      if (!native.ok && native.error.code !== 'workspace-file/not-found') return { kind: 'failed' }
      const result = await remote.workspaceFiles.read(sessionId, `${prefix}_工作区/生成进度.json`, {}, signal)
      if (!result.ok && result.error.code !== 'workspace-file/not-found') return { kind: 'failed' }
      if (!native.ok && !result.ok) return null
      if ((native.ok && !native.value.eof) || (result.ok && !result.value.eof)) return { kind: 'failed' }
      try {
        const value: unknown = result.ok ? JSON.parse(result.value.text) : {}
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'failed' }
        const state = value as Record<string, unknown>
        let stage = typeof state.stage === 'string' ? state.stage : 'other'
        let nextAction = typeof state.next_action === 'string' ? state.next_action.trim() || undefined : undefined
        let transcriptionRunning = false
        let transcriptionActive = false
        let completedStages: number | undefined
        if (native.ok) {
          const decoded: unknown = JSON.parse(native.value.text)
          if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return { kind: 'failed' }
          const cursor = decoded as Record<string, unknown>
          if (cursor.schemaVersion !== 1 || typeof cursor.stage !== 'string' || typeof cursor.status !== 'string') {
            return { kind: 'failed' }
          }
          stage = cursor.status === 'complete' ? 'complete'
            : cursor.status === 'waiting_confirmation' ? 'intake'
              : cursor.status === 'paused' || cursor.status === 'needs_review' ? cursor.status : 'working'
          nextAction = typeof cursor.nextAction === 'string' ? cursor.nextAction.trim() || undefined : undefined
          transcriptionRunning = cursor.stage === 'transcription' && cursor.status === 'running'
          transcriptionActive = cursor.stage === 'transcription' && cursor.status !== 'complete'
          if (typeof cursor.validated === 'object' && cursor.validated !== null && !Array.isArray(cursor.validated)) {
            const stages = ['materials', 'transcription', 'knowledge', 'path', 'lessons', 'cards', 'delivery']
            completedStages = stages.filter(key => Object.hasOwn(cursor.validated as object, key)).length
          }
        }
        // Older skill runs left the progress stage at "working" after a
        // successful packaged validation. The receipt is the stronger gate.
        if (stage !== 'complete' || native.ok) {
          const receipt = await remote.workspaceFiles.read(sessionId, `${prefix}_工作区/打包检查.json`, {}, signal)
          let packaged = false
          if (receipt.ok && receipt.value.eof) {
            try {
              const report: unknown = JSON.parse(receipt.value.text)
              if (typeof report === 'object' && report !== null && !Array.isArray(report)) {
                const check = report as Record<string, unknown>
                packaged = check.mode === 'packaged' && check.passed === true
              }
            } catch { /* A malformed receipt cannot supersede the progress file. */ }
          }
          if (native.ok && stage === 'complete' && !packaged) { stage = 'needs_review'; nextAction = undefined }
          else if (!native.ok && packaged) stage = 'complete'
        }
        let blockers = Array.isArray(state.blockers) ? state.blockers.length : 0
        let fontWarnings = 0
        if (transcriptionActive) {
          const office = await remote.workspaceFiles.read(sessionId, `${prefix}_工作区/office渲染报告.json`, {}, signal)
          if (office.ok && office.value.eof) {
            try {
              const report: unknown = JSON.parse(office.value.text)
              if (typeof report === 'object' && report !== null && !Array.isArray(report)
                && 'sources' in report && Array.isArray(report.sources)) {
                fontWarnings = report.sources.filter((source: unknown) => typeof source === 'object'
                  && source !== null && 'missingFonts' in source && Array.isArray(source.missingFonts)
                  && source.missingFonts.length > 0).length
              }
            } catch { /* Malformed Office report is not a course progress receipt. */ }
          }
        }
        if (transcriptionRunning) {
          const health = await remote.workspaceFiles.read(sessionId, `${prefix}_工作区/内置看门狗.json`, {}, signal)
          if (health.ok && health.value.eof) {
            try {
              const report: unknown = JSON.parse(health.value.text)
              if (typeof report === 'object' && report !== null && !Array.isArray(report)) {
                const check = report as Record<string, unknown>
                const issues = ['silentAttemptIds', 'stoppedAttemptIds', 'unknownAttemptIds']
                  .reduce((count, key) => count + (Array.isArray(check[key]) ? check[key].length : 0), 0)
                blockers = Math.max(blockers, issues)
              }
            } catch { /* A malformed health snapshot does not supersede the workflow state. */ }
          }
        }
        return {
          kind: 'ready',
          value: {
            stage,
            completedChapters: Array.isArray(state.completed_chapters) ? state.completed_chapters.length : 0,
            completedLessons: Array.isArray(state.completed_lessons) ? state.completed_lessons.length : 0,
            blockers,
            nextAction: stage === 'complete' ? undefined : nextAction,
            ...(completedStages === undefined ? {} : { completedStages }),
            ...(fontWarnings === 0 ? {} : { fontWarnings }),
          },
        }
      } catch {
        return { kind: 'failed' }
      }
    }

    const direct = await readAt('')
    if (direct) return direct
    // A new course may be created as the only child of the selected workspace.
    // Show its checkpoint without guessing when several courses share a root.
    const listing = await remote.workspaceFiles.list(sessionId, root, signal)
    if (!listing.ok || listing.value.truncated) return { kind: 'failed' }
    const directories = listing.value.entries.filter(entry => entry.type === 'directory' && entry.name !== '_工作区')
    if (directories.length > 16) return { kind: 'multiple' }
    const states = await Promise.all(directories.map(entry => readAt(`${entry.name}/`)))
    const courses = states.filter((state): state is CourseProgressResult => state !== null)
    if (courses.length > 1) return { kind: 'multiple' }
    return courses[0] ?? { kind: 'waiting' }
  }
}

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => Omit<FilesInjected, 'readCourseProgress'> {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): Omit<FilesInjected, 'readCourseProgress'> => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const roots = new Map<TabId, DirectoryNode>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      return list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
        return result.ok ? result.value : undefined
      })
    }
    return {
      refresh: (tabId) => { void roots.get(tabId)?.refreshTree() },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        roots.get(tabId)?.setAutomatic(enabled)
      },
      start(tabId, root, signal) {
        actions.start(tabId, root)
        signal.addEventListener('abort', () => {
          void roots.get(tabId)?.close()
          roots.delete(tabId)
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        roots.set(tabId, new DirectoryNode(root,
          (path, lifetime) => load(tabId, path, lifetime),
          (path, lifetime) => watch(sessionId, path, lifetime),
          (path, error) => {
            if (!signal.aborted) actions.failed(tabId, path, new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}))
          }, signal,
        ).open())
      },
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const root = roots.get(tabId)
        if (root === undefined) return
        const parent = root.find(parentPath)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        root.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
