/** Course names are the left navigation; reading retains a bound tutor panel. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Modal,
  Menu,
  Tooltip,
  IconHomeFillRegular,
  IconBranchOutlineRegular,
  IconEllipsisOutlineRegular,
  IconBookOpenOutlineRegular,
  IconSearchOutlineRegular,
  IconChevronsUpDownOutlineRegular,
  IconFolderCloseRegular,
  IconPlusOutlineRegular,
  IconEditOutlineRegular,
  IconRefreshOutlineRegular,
  IconSparkleRegular,
  IconPanelLeftOutlineRegular,
  IconFlatListOutlineRegular,
  IconLinkOutlineRegular,
  IconChevronUpOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PropsRuntime,
  PropsStore,
  PropsLocale,
  PropsRenderSlots,
  PropsRenderFactories,
  TranslateNS,
  HostObservable,
  InjectFace,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  CourseFileContent,
  CourseQuote,
  CourseRecord,
  ActiveCourseStudyAction,
} from '@deepseek-ai/dsh-util-course-document'
import type { createCourseViewStore } from './store.ts'
import { CourseDocumentView, type SelectedCourseText } from './DocumentView.tsx'
import { CourseImportDialog } from './Import.tsx'
import { CourseGraph } from './Graph.tsx'
import { CourseGraphSettingsPanel } from './GraphSettings.tsx'
import { defaultCourseGraphSettings, type CourseGraphSettings } from './graph-settings.ts'
import { CourseOutline } from './Outline.tsx'
import { CourseFileTree, visibleCourseEntry } from './FileTree.tsx'
import { courseAddress } from './resources.ts'
import { SelectionActions, type CourseSelection } from './SelectionActions.tsx'
import css from './workbench.module.css'
import { courseAnchorOffset } from './chat-links.ts'
import { afterCourseMath } from './reading-navigation.ts'

export interface CourseInjected {
  readonly hooks: { readonly courseTheme: HostObservable<number> }
  readonly request: <T>(input: Readonly<Record<string, unknown>>) => Promise<T>
  readonly refresh: () => void
  readonly droppedImportPath: (file: File) => string
  readonly home: () => Promise<void>
  readonly read: () => void
  readonly create: () => void
  readonly openCourse: (id: string) => void
  readonly openFile: (path: string, anchor?: string) => void
  readonly travel: (direction: -1 | 1) => void
  readonly generate: (id: string) => Promise<void>
  readonly tutor: (id: string) => Promise<void>
  readonly study: (id: string, kind: ActiveCourseStudyAction, range: SelectedCourseText) => Promise<void>
  readonly presentRight: (shown: boolean, track: boolean) => void
  readonly quote: (id: string, range: SelectedCourseText) => Promise<CourseQuote>
  readonly graphSettings: (id: string, settings: CourseGraphSettings) => void
  readonly graphOpen: (id: string, path: string) => void
  readonly reload: () => void
  readonly dirty: (id: string, path: string, revision: number, value: boolean) => void
}
type Shared = PropsStore<ReturnType<typeof createCourseViewStore>> & PropsLocale<'course'> & InjectFace<CourseInjected>
export type CourseSidebarProps = PropsRuntime<'sidebar.workspaces'> & Shared
export type CourseWorkbenchProps = PropsRuntime<'main'> & Shared

export function CourseSidebar(props: CourseSidebarProps) {
  const { useResource, useStore, t, openCourse, wide, expandSidebar, actions } = props
  const reading = props.usePanelInfo(info => info.activePanelId === 'courses')
  const state = useStore(s => s)
  const resource = useResource<'coursework'>(courseAddress('list'))
  if (!wide)
    return (
      <button className={css.railButton} title={t('courses')} aria-label={t('courses')} onClick={expandSidebar}>
        <IconFolderCloseRegular />
      </button>
    )
  if (reading) return <CourseFileNavigation key={state.selectedId} {...props} />
  const courses = resource.value?.courses ?? []
  return (
    <nav className={css.catalog} aria-label={t('courses')}>
      {state.searchOpen && (
        <SearchField
          value={state.catalogQuery}
          label={t('courseSearch')}
          change={(value) => {
            actions.patch({ catalogQuery: value })
          }}
          close={() => {
            actions.patch({ searchOpen: false, catalogQuery: '' })
          }}
        />
      )}
      <div className={css.catalogHeading}>
        <span>{t('courses')}</span>
      </div>
      <div className={css.courseList}>
        {courses
          .filter(course => course.name.toLocaleLowerCase().includes(state.catalogQuery.toLocaleLowerCase()))
          .map(course => (
            <div key={course.id} className={css.courseRow} data-selected={course.id === state.selectedId}>
              <button
                className={css.courseName}
                onClick={() => {
                  openCourse(course.id)
                }}
                title={course.name}
              >
                <IconFolderCloseRegular />
                <span>{course.name}</span>
              </button>
            </div>
          ))}
      </div>
      {resource.failure !== undefined && (
        <p role="alert" className={css.notice}>
          {resource.failure.message}
        </p>
      )}
      {courses.length === 0 && resource.status === 'live' && <p className={css.subtle}>{t('empty')}</p>}
    </nav>
  )
}
function FixedCourseChat(props: ConversationViewsProps) {
  return (
    <div className={css.studyMessages} data-conversation-region="view">
      {props.renderSlot('conversation.session', { view: 'chat' })}
    </div>
  )
}
export function CourseConversation({
  useSession,
  renderFactorySlot,
}: PropsRuntime<'course.study.conversation'> & PropsRenderFactories) {
  const session = useSession(s => s)
  const phase = session.openState === 'loading' ? 'settling' : 'active'
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase, hero: false },
    { slots: { views: FixedCourseChat } },
  )
}

type FileDialog = {
  kind: 'file' | 'folder' | 'rename' | 'trash'
  value: string
  source?: string
  token?: string
  affected?: readonly string[]
}
function Asset({ id, path, t }: { readonly id: string; readonly path: string; readonly t: TranslateNS<'course'> }) {
  const url = `/api/better-learning/course-asset?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`
  return (
    <section className={css.asset}>
      {/\.pdf$/iu.test(path) ? (
        <iframe className={css.pdf} title={path} src={url} />
      ) : /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(path) ? (
        <img className={css.image} src={url} alt={path} />
      ) : (
        <p>{t('unsupported')}</p>
      )}
    </section>
  )
}
function CreateCourse({
  request,
  refresh,
  generate,
  t,
}: {
  readonly request: CourseInjected['request']
  readonly refresh: () => void
  readonly generate: CourseInjected['generate']
  readonly t: TranslateNS<'course'>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className={css.createScreen}>
      <div className={css.createCard}>
        <h1>{t('newCourse')}</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            void request<CourseRecord>({ action: 'create', name })
              .then(async (course) => {
                refresh()
                await generate(course.id)
              })
              .catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          <label>
            {t('name')}
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              autoFocus
            />
          </label>
          <button className={css.primary} disabled={busy || name.trim() === ''} type="submit">
            {busy ? t('loading') : t('create')}
          </button>
        </form>
        {error !== '' && (
          <p role="alert" className={css.notice}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
export function CourseWorkbench(props: CourseWorkbenchProps) {
  const { useResource, useStore, t, actions } = props
  const state = useStore(s => s)
  const [selected, setSelected] = useState<CourseSelection>()
  const [mode, setMode] = useState<'read' | 'source'>('read')
  const [error, setError] = useState('')
  const [, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const overview = useResource<'coursework'>(courseAddress('overview', state.selectedId))
  const fileResource = useResource<'coursework'>(courseAddress('read', state.selectedId, state.path))
  const savedQuoteResource = useResource<'coursework'>(
    courseAddress('saved-quote', state.selectedId, state.quotePreview),
  )
  const file = fileResource.value?.file
  const files = overview.value?.files ?? []
  const activeText = /\.(?:md|markdown|txt)$/iu.test(state.path)
  useEffect(() => {
    if (state.path !== '' || overview.value?.files === undefined) return
    const available = overview.value.files.filter(
      item =>
        !item.directory &&
        visibleCourseEntry(item.path, overview.value?.course?.imported === true) &&
        /\.(?:md|markdown|txt)$/iu.test(item.path),
    )
    const first =
      available.find(item => item.path.startsWith('学习文档/')) ??
      available.find(item => item.path === '开始学习.md') ??
      available[0]
    if (first !== undefined) actions.patch({ path: first.path })
  }, [state.path, overview.value?.files, actions])
  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError('')
    void work()
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }
  useEffect(() => {
    if (file === undefined) return
    if (state.anchor === '') {
      if (state.navigationRevision > 0)
        root.current?.querySelector<HTMLElement>('[data-course-document]')?.scrollTo({
          top: 0,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        })
      return
    }
    const offset = courseAnchorOffset(file.document, state.anchor)
    const scroller = root.current?.querySelector<HTMLElement>('[data-course-document]')
    if (offset !== undefined && scroller !== undefined && scroller !== null) {
      return afterCourseMath(scroller, offset, () => {
        const exact = scroller.querySelector<HTMLElement>(`[data-block-start="${offset}"]`)
        const candidates = Array.from(
          exact === null ? scroller.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]') : [],
        ).filter(element => element.closest('[data-course-document]') === scroller)
        const heading =
          exact ??
          candidates
            .filter(
              element => Number(element.dataset.sourceStart) <= offset && Number(element.dataset.sourceEnd) > offset,
            )
            .sort(
              (a, b) =>
                Number(a.dataset.sourceEnd) -
                Number(a.dataset.sourceStart) -
                (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceStart)),
            )[0] ??
          candidates.find(element => Number(element.dataset.sourceStart) >= offset) ??
          candidates.at(-1)
        if (heading !== undefined) {
          const top = scroller.scrollTop + heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          scroller.scrollTo({
            top,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
          })
        }
      })
    }
  }, [file?.version, state.anchor, state.path, state.revision, state.navigationRevision])
  if (state.selectedId === '')
    return (
      <div className={css.createScreen}>
        <div className={css.createCard}>
          <h1>{t('readingMode')}</h1>
          <p>{t('chooseCourse')}</p>
        </div>
      </div>
    )
  return (
    <div className={css.workbench} ref={root} key={state.selectedId}>
      <header className={css.readerHeader}>
        <div className={css.readingHistory} role="group" aria-label={t('readingHistory')}>
          <Tooltip label={t('historyBack')} side="bottom">
            <button
              type="button"
              className={css.readerIcon}
              aria-label={t('historyBack')}
              disabled={state.historyIndex <= 0}
              onClick={() => {
                props.travel(-1)
              }}
            >
              <IconChevronLeftOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('historyForward')} side="bottom">
            <button
              type="button"
              className={css.readerIcon}
              aria-label={t('historyForward')}
              disabled={state.historyIndex >= state.history.length - 1}
              onClick={() => {
                props.travel(1)
              }}
            >
              <IconChevronRightOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
        <div className={css.readerTitle}>
          <strong title={overview.value?.course?.name}>{overview.value?.course?.name ?? t('courses')}</strong>
        </div>
        <div className={css.readerFileLine}>
          <Tooltip label={t('read')} side="bottom">
            <button
              className={css.readerIcon}
              type="button"
              aria-label={t('read')}
              aria-pressed={mode === 'read'}
              disabled={!activeText}
              onClick={() => {
                setMode('read')
                setSelected(undefined)
              }}
            >
              <IconBookOpenOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('edit')} side="bottom">
            <button
              className={css.readerIcon}
              type="button"
              aria-label={t('edit')}
              aria-pressed={mode === 'source'}
              disabled={!activeText}
              onClick={() => {
                setMode('source')
                setSelected(undefined)
              }}
            >
              <IconEditOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      {error !== '' && (
        <div role="status" className={css.notice}>
          {error}
        </div>
      )}
      <div className={css.workbenchBody}>
        <main className={css.readingPanel}>
          {activeText ? (
            file === undefined ? (
              <p role="status" className={css.notice}>
                {fileResource.failure?.message ?? t('loading')}
              </p>
            ) : (
              <CourseDocumentView
                key={`${state.selectedId}:${state.path}:${state.revision}`}
                id={state.selectedId}
                file={file}
                focus={courseAnchorOffset(file.document, state.anchor)}
                navigation={state.navigationRevision}
                files={files}
                mode={mode}
                t={t}
                useResource={useResource}
                open={props.openFile}
                select={(range) => {
                  const selection = window.getSelection()
                  const rect = selection?.rangeCount === 1 ? selection.getRangeAt(0).getBoundingClientRect() : undefined
                  setSelected(
                    range === undefined || rect === undefined || range.path !== state.path
                      ? undefined
                      : {
                        range,
                        owner: state.selectedId + ':' + state.path,
                        revision: state.navigationRevision,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                      },
                  )
                }}
                dirty={(value) => {
                  props.dirty(state.selectedId, state.path, state.revision, value)
                }}
                reload={props.reload}
                save={async (text, version) => {
                  const saved = await props.request<CourseFileContent>({
                    action: 'save',
                    id: state.selectedId,
                    path: state.path,
                    text,
                    version,
                  })
                  props.refresh()
                  return saved
                }}
              />
            )
          ) : state.path === '' ? null : (
            <Asset id={state.selectedId} path={state.path} t={t} />
          )}
        </main>
      </div>
      {mode === 'read' &&
        !state.unsaved &&
        selected !== undefined &&
        selected.owner === state.selectedId + ':' + state.path &&
        selected.revision === state.navigationRevision &&
        selected.range.version === file?.version && (
        <SelectionActions
          selection={selected}
          t={t}
          busy={state.studyPending}
          dismiss={() => {
            setSelected(undefined)
          }}
          run={(kind) => {
            const range = selected.range
            setSelected(undefined)
            run(async () => {
              await props.study(state.selectedId, kind, range)
            })
          }}
        />
      )}
      <Modal
        open={state.quotePreview !== ''}
        onClose={() => {
          actions.patch({ quotePreview: '' })
        }}
        title={t('quoteSaved')}
        closeLabel={t('cancel')}
      >
        {savedQuoteResource.value?.savedQuote === undefined ? (
          <p>{savedQuoteResource.failure?.message ?? t('loading')}</p>
        ) : (
          <div className={css.quotePreview}>
            <strong>{savedQuoteResource.value.savedQuote.quote.path}</strong>
            <p>{savedQuoteResource.value.savedQuote.current ? t('quoteCurrent') : t('quoteHistorical')}</p>
            <blockquote>{savedQuoteResource.value.savedQuote.quote.text}</blockquote>
            <details>
              <summary>{t('quoteFullSource')}</summary>
              <pre>{savedQuoteResource.value.savedQuote.snapshot}</pre>
            </details>
            <button
              disabled={!savedQuoteResource.value.savedQuote.current}
              onClick={() => {
                const quote = savedQuoteResource.value?.savedQuote?.quote
                if (quote !== undefined) {
                  props.openFile(quote.path, `@${quote.start}`)
                  actions.patch({ quotePreview: '' })
                }
              }}
            >
              {t('jump')}
            </button>
          </div>
        )}
      </Modal>
    </div>
  )
}

/** Persistent product mode entries; global plugin entries belong to the shell. */
export function CourseNavigation(props: PropsRuntime<'sidebar.studio.navigation'> & Shared) {
  const active = props.usePanelInfo(info => info.activePanelId)
  const [error, setError] = useState('')
  return (
    <>
      <Tooltip label={props.t('home')} side="right">
        <button
          type="button"
          className={css.modeButton}
          aria-label={props.t('home')}
          aria-current={active === null || active === 'course-home' ? 'page' : undefined}
          onClick={() => {
            setError('')
            void props.home().catch((reason: unknown) => {
              setError(String(reason))
            })
          }}
        >
          <IconHomeFillRegular size={20} />
        </button>
      </Tooltip>
      <Tooltip label={props.t('readingMode')} side="right">
        <button
          type="button"
          className={css.modeButton}
          aria-label={props.t('readingMode')}
          aria-current={active === 'courses' ? 'page' : undefined}
          onClick={props.read}
        >
          <IconBookOpenOutlineRegular size={20} />
        </button>
      </Tooltip>
      <Modal
        open={error !== ''}
        title={props.t('error')}
        closeLabel={props.t('cancel')}
        onClose={() => {
          setError('')
        }}
      >
        <p role="alert">{error}</p>
      </Modal>
    </>
  )
}
/** File browsing occupies the shell's one contextual sidebar, never the reading center. */
function CourseFileNavigation(props: CourseSidebarProps) {
  const { useStore, useResource, t, actions } = props
  const state = useStore(value => value)
  const overview = useResource<'coursework'>(courseAddress('overview', state.selectedId))
  const catalog = useResource<'coursework'>(courseAddress('list'))
  const searchResource = useResource<'coursework'>(courseAddress('search', state.selectedId, state.search))
  const files = (overview.value?.files ?? []).filter(file =>
    visibleCourseEntry(file.path, overview.value?.course?.imported === true),
  )
  const courses = catalog.value?.courses ?? []
  const [targetFolder, setTargetFolder] = useState('')
  const closed = state.folderStates[state.selectedId] ?? []
  const folders = files.filter(file => file.directory).map(file => file.path)
  const setClosed = (paths: readonly string[]): void => {
    actions.patch({ folderStates: { ...state.folderStates, [state.selectedId]: paths } })
  }
  const [dialog, setDialog] = useState<FileDialog>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fileMenu, setFileMenu] = useState<{ path: string; rect: DOMRect }>()
  const [switchOpen, setSwitchOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const switchAnchor = useRef<HTMLButtonElement>(null)
  return (
    <nav className={css.catalog} aria-label={t('files')}>
      <div className={css.explorerTools} role="toolbar" aria-label={t('fileTools')}>
        <Tooltip label={t('newFile')} side="bottom">
          <button
            type="button"
            aria-label={t('newFile')}
            disabled={state.selectedId === ''}
            onClick={() => {
              setDialog({ kind: 'file', value: (targetFolder === '' ? '' : targetFolder + '/') + '未命名.md' })
            }}
          >
            <IconEditOutlineRegular size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t('newFolder')} side="bottom">
          <button
            type="button"
            aria-label={t('newFolder')}
            disabled={state.selectedId === ''}
            onClick={() => {
              setDialog({ kind: 'folder', value: (targetFolder === '' ? '' : targetFolder + '/') + '新建文件夹' })
            }}
          >
            <span className={css.folderAddIcon}>
              <IconFolderCloseRegular size={16} />
              <IconPlusOutlineRegular size={8} />
            </span>
          </button>
        </Tooltip>
        <Tooltip label={t('collapseFolders')} side="bottom">
          <button
            type="button"
            aria-label={t('collapseFolders')}
            disabled={folders.length === 0}
            onClick={() => {
              setClosed(folders)
            }}
          >
            <IconChevronUpOutlineRegular size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t('expandFolders')} side="bottom">
          <button
            type="button"
            aria-label={t('expandFolders')}
            disabled={folders.length === 0}
            onClick={() => {
              setClosed([])
            }}
          >
            <IconChevronDownOutlineRegular size={16} />
          </button>
        </Tooltip>
      </div>
      {state.searchOpen && (
        <SearchField
          value={state.search}
          label={t('documentSearch')}
          change={(value) => {
            actions.patch({ search: value })
          }}
          close={() => {
            actions.patch({ searchOpen: false, search: '' })
          }}
        />
      )}
      <div className={css.fileList}>
        {state.search !== '' ? (
          [
            ...files
              .filter(
                item => !item.directory && item.path.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()),
              )
              .map(item => ({ path: item.path, excerpt: '' })),
            ...(searchResource.value?.results ?? [])
              .filter(item => visibleCourseEntry(item.path, overview.value?.course?.imported === true))
              .filter(
                item =>
                  !files.some(
                    file =>
                      !file.directory &&
                      file.path === item.path &&
                      file.path.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()),
                  ),
              ),
          ].map(item => (
            <button
              className={css.searchResult}
              key={item.path}
              onClick={() => {
                props.openFile(item.path)
              }}
            >
              <strong>{item.path}</strong>
              <small>{item.excerpt}</small>
            </button>
          ))
        ) : (
          <CourseFileTree
            files={files}
            selected={state.path}
            closed={closed}
            label={t('files')}
            open={(path) => {
              setTargetFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
              props.openFile(path)
            }}
            toggle={(path) => {
              setTargetFolder(path)
              setClosed(closed.includes(path) ? closed.filter(item => item !== path) : [...closed, path])
            }}
            context={(path, rect) => {
              setFileMenu({ path, rect })
              setTargetFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
            }}
          />
        )}
      </div>
      {overview.failure !== undefined && <p role="alert">{overview.failure.message}</p>}
      {searchResource.failure !== undefined && <p role="alert">{searchResource.failure.message}</p>}

      <div className={css.courseSwitch}>
        <Menu
          open={switchOpen}
          className={css.switchMenu}
          anchor={
            <button
              ref={switchAnchor}
              type="button"
              className={css.switchButton}
              aria-haspopup="menu"
              aria-expanded={switchOpen}
              onClick={() => {
                setSwitchOpen(value => !value)
              }}
            >
              <IconChevronsUpDownOutlineRegular size={16} />
              <span>{t('switchCourse')}</span>
            </button>
          }
          getAnchorRect={() => switchAnchor.current?.getBoundingClientRect() ?? null}
          portal
          side="top"
          selectedId={state.selectedId}
          items={[
            ...courses.map(course => ({
              id: course.id,
              label: course.name,
              icon: <IconFolderCloseRegular size={16} />,
            })),
            { type: 'separator', id: 'import-separator' },
            { id: 'import-course', label: t('importCourse'), icon: <IconPlusOutlineRegular size={16} /> },
          ]}
          onClose={() => {
            setSwitchOpen(false)
          }}
          onSelect={(id) => {
            setSwitchOpen(false)
            if (id === 'import-course') setImportOpen(true)
            else props.openCourse(id)
          }}
        />
      </div>
      {importOpen && (
        <CourseImportDialog
          t={t}
          request={props.request}
          droppedPath={props.droppedImportPath}
          close={() => {
            setImportOpen(false)
          }}
          imported={(course) => {
            props.refresh()
            setImportOpen(false)
            props.openCourse(course.id)
          }}
        />
      )}
      <Menu
        open={fileMenu !== undefined}
        anchor={null}
        portal
        getAnchorRect={() => fileMenu?.rect ?? null}
        items={[
          { id: 'rename', label: t('rename') },
          { id: 'trash', label: t('remove'), danger: true },
        ]}
        onClose={() => {
          setFileMenu(undefined)
        }}
        onSelect={(kind) => {
          if (fileMenu !== undefined)
            setDialog({ kind: kind === 'rename' ? 'rename' : 'trash', value: fileMenu.path, source: fileMenu.path })
          setFileMenu(undefined)
        }}
      />
      <Modal
        open={dialog !== undefined}
        title={
          dialog?.kind === 'rename'
            ? t('rename')
            : dialog?.kind === 'trash'
              ? t('remove')
              : dialog?.kind === 'folder'
                ? t('newFolder')
                : t('newFile')
        }
        closeLabel={t('cancel')}
        onClose={() => {
          if (!busy) setDialog(undefined)
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            void (async () => {
              if (dialog === undefined) return
              const source = dialog.source ?? state.path
              if (dialog.kind === 'rename') {
                const plan = await props.request<{ token: string; affected: readonly string[] }>({
                  action: 'rename',
                  id: state.selectedId,
                  from: source,
                  to: dialog.value,
                  commit: dialog.token !== undefined,
                  ...(dialog.token === undefined ? {} : { token: dialog.token }),
                })
                if (dialog.token === undefined) {
                  setDialog({ ...dialog, ...plan })
                  return
                }
                if (state.path === source) props.openFile(dialog.value)
              } else if (dialog.kind === 'trash') {
                await props.request({ action: 'trash', id: state.selectedId, path: source })
                if (state.path === source) props.openFile('课程首页.md')
              } else {
                await props.request({
                  action: 'create-file',
                  id: state.selectedId,
                  path: dialog.value,
                  directory: dialog.kind === 'folder',
                })
                setClosed(closed.filter(folder => dialog.value !== folder && !dialog.value.startsWith(folder + '/')))
                if (dialog.kind === 'file') props.openFile(dialog.value)
                else setTargetFolder(dialog.value)
              }
              props.refresh()
              setDialog(undefined)
            })()
              .catch((reason: unknown) => {
                setError(String(reason))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          {dialog?.kind === 'trash' ? (
            <p>{t('removeConfirm')}</p>
          ) : (
            <label className={css.dialogInput}>
              {t('path')}
              <input
                autoFocus
                required
                value={dialog?.value ?? ''}
                onChange={(event) => {
                  if (dialog !== undefined)
                    setDialog({
                      kind: dialog.kind,
                      value: event.target.value,
                      ...(dialog.source === undefined ? {} : { source: dialog.source }),
                    })
                }}
              />
            </label>
          )}
          {dialog?.token !== undefined && (
            <div>
              <p>{t('renameHelp')}</p>
              <ul>
                {dialog.affected?.map(path => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          )}
          {error !== '' && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || dialog?.value === ''}>
            {dialog?.kind === 'rename' && dialog.token === undefined ? t('preview') : t('confirm')}
          </button>
        </form>
      </Modal>
    </nav>
  )
}
/** Home entry shows course creation without registering a second tutor slot. */
export function CourseHome(props: PropsRuntime<'main'> & Shared) {
  return <CreateCourse {...props} />
}

/** Single search entry, owned by the contextual sidebar heading. */
export function CourseSearchButton(props: PropsRuntime<'sidebar.studio.search'> & Shared) {
  const open = props.useStore(state => state.searchOpen)
  return (
    <Tooltip label={props.t('searchAndFilter')} side="bottom">
      <button
        type="button"
        className={css.searchToggle}
        aria-label={props.t('searchAndFilter')}
        aria-expanded={open}
        onClick={() => {
          props.actions.patch({ searchOpen: !open, ...(open ? { search: '', catalogQuery: '' } : {}) })
        }}
      >
        <IconSearchOutlineRegular size={17} />
      </button>
    </Tooltip>
  )
}
function SearchField({
  value,
  change,
  close,
  label,
}: {
  readonly value: string
  readonly change: (value: string) => void
  readonly close: () => void
  readonly label: string
}) {
  return (
    <input
      type="search"
      autoFocus
      className={css.unifiedSearch}
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => {
        change(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
    />
  )
}

/** Root-panel occupant of the existing rightbar host; one surface for reference and tutoring. */
export function CourseRightPanel(
  props: PropsRuntime<'rightbar.panel'> & Shared & PropsRenderSlots<'course.study.conversation'>,
) {
  const { useStore, useResource, t } = props
  const state = useStore(value => value)
  const themeRevision = props.useCourseTheme(value => value)
  const isReading = props.usePanelInfo(info => info.activePanelId === 'courses')
  const referenceActive = isReading && state.rightOpen && state.selectedId !== ''
  const fileResource = useResource<'coursework'>(
    courseAddress('read', referenceActive && state.rightTab === 'outline' ? state.selectedId : '', state.path),
  )
  const linkResource = useResource<'coursework'>(
    courseAddress('links', referenceActive && state.rightTab === 'links' ? state.selectedId : '', state.path),
  )
  const chat = useResource<'coursechat'>(
    `dsh-resource://coursechat/session?session=${encodeURIComponent(state.tutorSession ?? '')}`,
  )
  const file = fileResource.value?.file,
    links = linkResource.value?.links ?? []
  const shown = state.rightOpen && state.selectedId !== ''
  useLayoutEffect(() => {
    props.presentRight(shown, shown && props.canShow)
    return () => {
      props.presentRight(false, false)
    }
  }, [props.presentRight, shown, props.canShow])
  if (state.selectedId === '') return null
  return (
    <aside
      className={css.courseRight}
      data-course-right-open={state.rightOpen || undefined}
      aria-label={t('courseRight')}
      aria-hidden={!state.rightOpen}
      style={{ width: props.canShow ? props.width : Math.max(0, props.viewportWidth - 56) }}
    >
      <div className={css.referenceBody} hidden={state.rightTab === 'tutor'}>
        {state.rightTab === 'outline' && (
          <CourseOutline
            headings={file?.document.headings ?? []}
            label={t('outline')}
            open={(start) => {
              props.openFile(state.path, '@' + String(start))
            }}
          />
        )}
        {state.rightTab === 'graph' && state.rightOpen && isReading && (
          <CourseGraph
            key={state.selectedId}
            id={state.selectedId}
            path={state.path}
            useResource={useResource}
            settings={state.graphSettings[state.selectedId] ?? defaultCourseGraphSettings}
            playing={state.graphPlaying}
            animationRevision={state.graphAnimationRevision}
            stopped={() => {
              props.actions.patch({ graphPlaying: false })
            }}
            open={(path) => {
              props.graphOpen(state.selectedId, path)
            }}
            t={t}
            refresh={props.refresh}
            saveLayout={(layout) => {
              void props.request({ action: 'graph-layout', id: state.selectedId, layout }).catch((error: unknown) => {
                console.warn('course graph: layout was not saved', error instanceof Error ? error.name : 'invalid data')
              })
            }}
            themeRevision={themeRevision}
          />
        )}
        {state.rightTab === 'links' && (
          <div className={css.contextContent}>
            {links
              .filter(link => link.path === state.path)
              .map((link, index) => (
                <button
                  key={`${link.from}:${index}`}
                  onClick={() => {
                    props.openFile(link.from)
                  }}
                >
                  {link.from}
                </button>
              ))}
          </div>
        )}
        {linkResource.failure !== undefined && (
          <p role="alert" className={css.notice}>
            {linkResource.failure.message}
          </p>
        )}
      </div>
      {state.tutorSession !== null && (
        <section className={css.studyBody} hidden={state.rightTab !== 'tutor'} aria-label={t('tutor')}>
          {chat.value === undefined ? (
            <p>{t('loading')}</p>
          ) : (
            <props.SessionProvider session={chat.value.reference}>
              {props.renderSlot('course.study.conversation', {})}
            </props.SessionProvider>
          )}
        </section>
      )}
      {state.notice !== '' && (
        <p className={css.notice} role="status">
          {state.notice}
        </p>
      )}
    </aside>
  )
}
/** One fixed control group, independent of rightbar expansion and active content. */
export function CourseReaderControls(props: PropsRuntime<'shell.overlay'> & Shared) {
  const active = props.usePanelInfo(info => info.activePanelId === 'courses')
  const state = props.useStore(value => value)
  const [error, setError] = useState('')
  const graphMenu = useRef<HTMLButtonElement>(null)
  if (!active || state.selectedId === '') return null
  return (
    <div className={css.readerControls} role="toolbar" aria-label={props.t('readerControls')}>
      <Tooltip label={props.t('refresh')} side="bottom">
        <button type="button" aria-label={props.t('refresh')} onClick={props.refresh}>
          <IconRefreshOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={props.t('outline')} side="bottom">
        <button
          type="button"
          aria-label={props.t('outline')}
          aria-pressed={state.rightOpen && state.rightTab === 'outline'}
          onClick={() => {
            props.actions.patch({ rightOpen: true, rightTab: 'outline', graphSettingsOpen: false, graphPlaying: false })
          }}
        >
          <IconFlatListOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={props.t('backlinks')} side="bottom">
        <button
          type="button"
          aria-label={props.t('backlinks')}
          aria-pressed={state.rightOpen && state.rightTab === 'links'}
          onClick={() => {
            props.actions.patch({ rightOpen: true, rightTab: 'links', graphSettingsOpen: false, graphPlaying: false })
          }}
        >
          <IconLinkOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={props.t('graph')} side="bottom">
        <button
          type="button"
          aria-label={props.t('graph')}
          aria-pressed={state.rightOpen && state.rightTab === 'graph'}
          onClick={() => {
            props.actions.patch({ rightOpen: true, rightTab: 'graph', graphSettingsOpen: false })
          }}
        >
          <IconBranchOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={props.t('tutorOpen')} side="bottom">
        <button
          type="button"
          aria-label={props.t('tutorOpen')}
          aria-pressed={state.rightOpen && state.rightTab === 'tutor'}
          onClick={() => {
            setError('')
            props.actions.patch({ graphSettingsOpen: false, graphPlaying: false })
            void props.tutor(state.selectedId).catch((reason: unknown) => {
              setError(String(reason))
            })
          }}
        >
          <IconSparkleRegular size={16} />
        </button>
      </Tooltip>
      <div className={css.readerRightActions}>
        <Tooltip label={props.t(state.rightOpen ? 'rightClose' : 'rightOpen')} side="bottom">
          <button
            type="button"
            aria-label={props.t(state.rightOpen ? 'rightClose' : 'rightOpen')}
            aria-expanded={state.rightOpen}
            onClick={() => {
              props.actions.patch({ rightOpen: !state.rightOpen, graphSettingsOpen: false, graphPlaying: false })
            }}
          >
            <IconPanelLeftOutlineRegular className={css.rightToggleIcon} size={16} />
          </button>
        </Tooltip>
        {state.rightTab === 'graph' && state.rightOpen && (
          <Tooltip label={props.t('graphSettings')} side="bottom">
            <button
              ref={graphMenu}
              type="button"
              aria-label={props.t('graphSettings')}
              aria-expanded={state.graphSettingsOpen}
              onClick={() => {
                props.actions.patch({ graphSettingsOpen: !state.graphSettingsOpen })
              }}
            >
              <IconEllipsisOutlineRegular className={css.graphMoreIcon} size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      {state.rightTab === 'graph' && state.rightOpen && (
        <CourseGraphSettingsPanel
          key={state.selectedId}
          open={state.graphSettingsOpen}
          settings={state.graphSettings[state.selectedId] ?? defaultCourseGraphSettings}
          change={(settings) => {
            props.graphSettings(state.selectedId, settings)
          }}
          anchor={graphMenu}
          close={() => {
            props.actions.patch({ graphSettingsOpen: false })
          }}
          t={props.t}
          failed={state.graphSettingsFailed}
          playing={state.graphPlaying}
          play={() => {
            props.actions.patch({
              graphPlaying: !state.graphPlaying,
              graphAnimationRevision: state.graphAnimationRevision + 1,
            })
          }}
        />
      )}
      <Modal
        open={error !== ''}
        title={props.t('error')}
        closeLabel={props.t('cancel')}
        onClose={() => {
          setError('')
        }}
      >
        <p role="alert">{error}</p>
      </Modal>
    </div>
  )
}
