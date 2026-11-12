/** Studio-only composition over the public layout, resources and Conversation faces. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { loadCourseGraphSettings, saveCourseGraphSettings, defaultCourseGraphSettings } from './graph-settings.ts'
import { createStudioMarkdownPreference, MarkdownPreference } from './Presentation.tsx'
import { CourseNoteAction, CourseNoteToast, type CourseNoteTarget } from './Notes.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { serializeCourseQuote, studyActionSkill, type CourseQuote } from '@deepseek-ai/dsh-util-course-document'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import {
  CourseSidebar,
  CourseWorkbench,
  CourseConversation,
  CourseNavigation,
  CourseSearchButton,
  CourseHome,
  CourseRightPanel,
  CourseReaderControls,
  type CourseInjected,
} from './Workbench.tsx'
import { courseResourceOwner, courseRequest, CourseRequestError } from './resources.ts'
import { createCourseViewStore } from './store.ts'
import { en, zh } from './locales.ts'
import { CourseQuoteChip, courseQuoteRule, parseCourseQuoteRef, type CourseQuoteRef } from './quotes.tsx'
import type { CourseData } from './resources.ts'
import { hiddenStudyActionDefinition, retiredExplanationContextRule } from './study-chat.ts'
import { CourseStudyDisplay } from './StudyDisplay.tsx'
import { resolveTutorFile } from './chat-links.ts'
import type { UiWorkspaceService } from '../navigation.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    course: keyof typeof zh
  }
  interface SlotMap {
    'course.study.conversation': { kind: 'single'; scope: 'session' }
  }
}
/**
 * Mount the fixed course catalog and reading surface.
 * @param ctx - Client plugin context.
 * @param uiWorkspace - Existing main-Session navigation service.
 */
export function installCourseWorkbench(ctx: Context, uiWorkspace: UiWorkspaceService): void {
  const panel = 'courses' as MainPanelId
  const homePanel = 'course-home' as MainPanelId
  const handle = createCourseViewStore()
  const view = handle.create()
  const store: typeof handle = { ...handle, create: () => view }
  let target: CourseNoteTarget | undefined
  let targetKey = ''
  const noteTarget = {
    subscribe: (listener: () => void) => view.subscribe(listener),
    getSnapshot: (): CourseNoteTarget | undefined => {
      const current = view.getSnapshot()
      const key = JSON.stringify([current.selectedId, current.path, current.tutorSession])
      if (key !== targetKey) {
        targetKey = key
        target =
          current.selectedId !== '' && current.tutorSession !== null && /\.(?:md|markdown|txt)$/iu.test(current.path)
            ? { id: current.selectedId, path: current.path, sessionId: current.tutorSession }
            : undefined
      }
      return target
    },
  }
  const noteToast = createSnapshotStore<{ readonly path: string; readonly seq: number } | null>(null)
  let toastSeq = 0
  const markdown = createStudioMarkdownPreference()
  ctx.effect(() => {
    const publish = (): void => {
      document.documentElement.dataset.studioMarkdown = markdown.source.getSnapshot() ? 'on' : 'off'
    }
    publish()
    const dispose = markdown.source.subscribe(publish)
    return () => {
      dispose()
      delete document.documentElement.dataset.studioMarkdown
    }
  }, 'course: shared Markdown presentation')
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'studio-markdown',
        order: 25,
        locale: 'course',
        inject: () => ({ hooks: { markdownBeauty: markdown.source }, setEnabled: markdown.set }),
      },
      MarkdownPreference,
    ),
  )
  const resources = courseResourceOwner(ctx)
  const t = ctx.locale.bind('course')
  ctx.effect(() => ctx.locale.register('course', { zh, en }), 'course: dictionaries')
  ctx.effect(() => ctx.resources.register(resources.data), 'course: document resources')
  ctx.effect(() => ctx.resources.register(resources.chat), 'course: explicit tutor Session resources')
  const leave = (): boolean => !view.getSnapshot().unsaved || window.confirm(t('leave'))
  const reveal = (): void => {
    navigation++
    ctx.layout.beginNavigation()
    ctx.layout.selectPanel(panel)
  }
  let navigation = 0
  ctx.on('layout/rightbar-collapse-request', (activePanel) => {
    if (activePanel === panel) view.actions.patch({ rightOpen: false })
  })
  const openCourse: CourseInjected['openCourse'] = (id) => {
    if (!leave()) return
    navigation++
    let graphSettings = defaultCourseGraphSettings, graphSettingsFailed = false
    try { graphSettings = loadCourseGraphSettings(localStorage,id) }
    catch (error) { console.error('course graph: preferences unavailable',error);graphSettingsFailed=true }
    view.actions.patch({
      graphSettings: { ...view.getSnapshot().graphSettings,[id]:graphSettings }, graphSettingsFailed,
      graphSettingsOpen:false,graphPlaying:false,
      rightOpen: true,
      rightTab: 'outline',
      studyPending: false,
      selectedId: id,
      history: [],
      historyIndex: -1,
      path: '',
      anchor: '',
      search: '',
      creating: false,
      unsaved: false,
      tutorSession: null,
      notice: '',
      quotePreview: '',
      revision: view.getSnapshot().revision + 1,
    })
    reveal()
  }
  const tutor = async (id: string): Promise<string> => {
    const { sessionId } = await courseRequest<{ sessionId: string }>({ action: 'session', id, role: 'learning' })
    if (view.getSnapshot().selectedId === id)
      view.actions.patch({ tutorSession: sessionId, rightOpen: true, rightTab: 'tutor' })
    resources.refresh()
    return sessionId
  }
  const face: CourseInjected = {
    graphOpen: (id,path) => {
      const state=view.getSnapshot()
      if (state.selectedId === id && state.rightOpen && state.rightTab === 'graph') face.openFile(path)
    },
    graphSettings: (id,settings) => {
      const state = view.getSnapshot()
      if (state.selectedId !== id) return
      let failed = false
      try { saveCourseGraphSettings(localStorage,id,settings) }
      catch (error) { console.error('course graph: preferences not saved',error);failed=true }
      view.actions.patch({ graphSettings:{ ...state.graphSettings,[id]:settings },graphSettingsFailed:failed })
    },
    home: async () => {
      const id = view.getSnapshot().selectedId
      if (id === '') face.create()
      else await face.generate(id)
    },
    read: () => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel) return
      if (!leave()) return
      view.actions.patch({ creating: false, unsaved: false })
      reveal()
    },
    hooks: {
      courseTheme: {
        getSnapshot: () => ctx.theme.getTheme().revision,
        subscribe: listener =>
          ctx.on('theme/change', () => {
            listener()
          }),
      },
    },
    presentRight: (shown, track) => {
      if (shown) ctx.layout.openRightbar(track, false)
      else ctx.layout.closeRightbar()
    },
    study: async (id, kind, range) => {
      const owner = view.getSnapshot()
      if (owner.studyPending) throw new Error(t('actionBusy'))
      if (owner.unsaved) throw new Error(t('saveFirst'))
      if (owner.selectedId !== id || owner.path !== range.path) throw new Error(t('selectFirst'))
      view.actions.patch({ studyPending: true, notice: '' })
      try {
        await tutor(id)
        const current = view.getSnapshot()
        if (
          current.selectedId !== id ||
          current.path !== owner.path ||
          current.revision !== owner.revision ||
          current.navigationRevision !== owner.navigationRevision
        )
          return
        await courseRequest({ action: 'study-action', id, kind, ...range, operationId: randomUUID() })
      } catch (reason) {
        const code = reason instanceof CourseRequestError ? reason.code : undefined
        const message =
          code === 'COURSE_STUDY_SKILL_MISSING'
            ? t('studySkillMissing', { name: studyActionSkill(kind) })
            : code === 'COURSE_STUDY_BUSY'
            ? t('actionBusy')
            : code === 'COURSE_STUDY_MODEL_UNAVAILABLE'
              ? t('modelUnavailable')
              : reason instanceof Error && code === undefined
                ? reason.message
                : t('actionUnavailable')
        if (view.getSnapshot().selectedId === id) view.actions.patch({ notice: message })
      } finally {
        if (view.getSnapshot().selectedId === id) view.actions.patch({ studyPending: false })
      }
    },
    droppedImportPath: file =>
      (globalThis as { __DSH_HOST_PATHS__?: { pathFor: (file: File) => string } }).__DSH_HOST_PATHS__?.pathFor(file) ??
      '',
    request: courseRequest,
    refresh: resources.refresh,
    dirty: (id, path, revision, value) => {
      const selected = view.getSnapshot()
      if (selected.selectedId === id && selected.path === path && selected.revision === revision) {
        view.actions.patch({ unsaved: value })
      }
    },
    create: () => {
      if (!leave()) return
      navigation++
      view.actions.patch({
        creating: true,
        unsaved: false,
        tutorSession: null,
        notice: '',
        revision: view.getSnapshot().revision + 1,
      })
      ctx.layout.beginNavigation()
      ctx.layout.selectPanel(homePanel)
      ctx.layout.closeRightbar()
    },
    openCourse,
    openFile: (path, anchor = '') => {
      if (!leave()) return
      view.actions.navigate({ path, anchor })
      reveal()
    },
    travel: (direction) => {
      if (!leave()) return
      view.actions.travel(direction)
      reveal()
    },
    generate: async (id) => {
      if (!leave()) return
      const current = ++navigation
      const signal = ctx.layout.beginNavigation()
      const { sessionId } = await courseRequest<{ sessionId: string }>({ action: 'session', id, role: 'generation' })
      if (signal.aborted || navigation !== current) return
      view.actions.patch({
        selectedId: id,
        creating: false,
        unsaved: false,
        tutorSession: null,
        notice: '',
        revision: view.getSnapshot().revision + 1,
      })
      uiWorkspace.openSession(sessionId as SessionId)
      resources.refresh()
    },
    tutor: async (id) => {
      await tutor(id)
    },
    quote: async (id, range) => {
      const quote = await courseRequest<CourseQuote>({ action: 'quote', id, ...range })
      const sessionId = await tutor(id)
      await ctx.sessions.using(sessionId as SessionId, { source: 'workspaceOperation' }, (reference) => {
        const input = ctx.conversation.input.for(reference.binding.ctx)
        const span = input.actions.captureInsertion()
        const ref = JSON.stringify({ courseId: id, quoteId: quote.id, path: quote.path })
        if (
          !input.insertReference(
            {
              source: 'course-quote',
              ref,
              label: t('quoteLabel') + ' · ' + quote.path,
              appearance: 'file',
              clipboardText: t('quoteLabel') + ' · ' + quote.path,
            },
            { ...span, start: span.end },
          )
        )
          throw new Error(t('quoteInsertFailed'))
        const next = input.actions.captureInsertion()
        input.actions.insertText('\n' + t('quoteQuestion'), { ...next, start: next.end })
        input.focus()
      })
      if (view.getSnapshot().selectedId === id) view.actions.patch({ notice: t('quoteAdded') })
      return quote
    },
    reload: () => {
      if (!leave()) return
      view.actions.patch({ unsaved: false, revision: view.getSnapshot().revision + 1 })
      resources.refresh()
    },
  }
  ctx.on('conversation/file-open', (sessionId, path, options) => {
    const current = view.getSnapshot()
    if (current.selectedId === '' || current.tutorSession !== sessionId) return
    const navigationTicket = ++navigation
    return (async () => {
      const overview = await courseRequest<CourseData>({ action: 'overview', id: current.selectedId })
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      const target = resolveTutorFile(
        path,
        cwd,
        current.path,
        (overview.files ?? []).filter(file => !file.directory).map(file => file.path),
      )
      if (target.path === undefined)
        throw new Error(target.ambiguous.length > 1 ? t('courseLinkAmbiguous') : t('courseLinkMissing'))
      let anchor = options?.anchor ?? ''
      if (options?.line !== undefined) {
        const file = await courseRequest<{ text: string }>({
          action: 'read',
          id: current.selectedId,
          path: target.path,
        })
        let offset = 0
        for (let line = 1; line < options.line; line++) {
          const next = file.text.indexOf('\n', offset)
          if (next < 0) {
            offset = file.text.length
            break
          }
          offset = next + 1
        }
        anchor = '@' + String(offset)
      }
      const latest = view.getSnapshot()
      if (
        latest.selectedId !== current.selectedId ||
        latest.tutorSession !== sessionId ||
        navigation !== navigationTicket
      )
        return
      face.openFile(target.path, anchor)
    })()
  })
  const preview = (ref: CourseQuoteRef): void => {
    if (view.getSnapshot().selectedId !== ref.courseId) {
      if (!leave()) return
      openCourse(ref.courseId)
    }
    view.actions.patch({ quotePreview: ref.quoteId })
    reveal()
  }
  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: '@',
        name: 'course-quote',
        showGroupTitle: false,
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        openReference: (_session, reference) => {
          preview(parseCourseQuoteRef(reference.ref))
          return true
        },
        codec: {
          clipboardText: ref => t('quoteLabel') + ' · ' + parseCourseQuoteRef(ref).path,
          serialize: async (ref, signal) => {
            const decoded = parseCourseQuoteRef(ref)
            const saved = await courseRequest<NonNullable<CourseData['savedQuote']>>(
              { action: 'saved-quote', id: decoded.courseId, quoteId: decoded.quoteId },
              signal,
            )
            return t('quoteInstruction') + '\n' + serializeCourseQuote(saved.quote)
          },
        },
      }),
    'course: source reference codec',
  )
  ctx.effect(
    () => ctx.uiConversation.events.register(hiddenStudyActionDefinition),
    'course: hide automatic task prompts from chat',
  )
  ctx.effect(() => ctx.uiConversation.userText.register(courseQuoteRule), 'course: durable source chips')
  ctx.effect(() => ctx.uiConversation.userText.register(retiredExplanationContextRule), 'course: hide retired context in history')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'course-study-display', locale: 'course',
  }, CourseStudyDisplay))
  ctx.slots.inject('conversation.user.text.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.user.text.node',
        key: 'coursequote',
        locale: 'course',
        inject: () => ({ openQuote: preview }),
      },
      CourseQuoteChip,
    ),
  )
  ctx.effect(
    () =>
      ctx.shortcuts.register({
        id: 'session.new' as ShortcutCommandId,
        label: () => t('newCourse'),
        aliases: ['new course'],
        defaults: {
          'desktop:windows': { code: 'KeyN', modifiers: ['primary'] },
          'desktop:macos': { code: 'KeyN', modifiers: ['primary'] },
          'desktop:linux': { code: 'KeyN', modifiers: ['primary'] },
        },
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: () => ({ status: 'handled', run: face.create }),
      }),
    'course: new-course keyboard entry',
  )
  ctx.effect(
    () => uiWorkspace.setNewSessionHandler(face.create),
    'course: route new-session gestures to course creation',
  )
  ctx.slots.inject('sidebar.studio.search', () =>
    ctx.slots.register(
      { name: 'sidebar.studio.search', store, locale: 'course', inject: () => face },
      CourseSearchButton,
    ),
  )
  ctx.slots.inject('sidebar.studio.navigation', () =>
    ctx.slots.register(
      { name: 'sidebar.studio.navigation', store, locale: 'course', inject: () => face },
      CourseNavigation,
    ),
  )
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: homePanel, store, locale: 'course', inject: () => face }, CourseHome),
  )
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register({ name: 'sidebar.workspaces', store, locale: 'course', inject: () => face }, CourseSidebar),
  )
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      {
        name: 'main',
        key: panel,
        store,
        locale: 'course',
        inject: () => face,
      },
      CourseWorkbench,
    )
    ctx.layout.selectPanel(homePanel)
    return dispose
  })
  ctx.slots.inject('rightbar.panel', () =>
    ctx.slots.register(
      {
        name: 'rightbar.panel',
        key: panel,
        store,
        locale: 'course',
        inject: () => face,
        children: { 'course.study.conversation': { kind: 'single', scope: 'session' } },
      },
      CourseRightPanel,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'course-reader-controls', store, locale: 'course', inject: () => face },
      CourseReaderControls,
    ),
  )
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'course-note',
        order: 10,
        locale: 'course',
        inject: () => ({
          hooks: { courseNoteTarget: noteTarget },
          request: courseRequest,
          refresh: resources.refresh,
          saved: (path: string) => {
            noteToast.set({ path, seq: ++toastSeq })
          },
        }),
      },
      CourseNoteAction,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'course-note-toast',
        locale: 'course',
        inject: () => ({
          hooks: { courseNoteToast: noteToast },
          dismiss: () => {
            noteToast.set(null)
          },
        }),
      },
      CourseNoteToast,
    ),
  )
  ctx.slots.inject('course.study.conversation', () =>
    ctx.slots.register({ name: 'course.study.conversation' }, CourseConversation),
  )
}
