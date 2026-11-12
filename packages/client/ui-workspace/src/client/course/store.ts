/** Shared course selection is viewing state, separate from resource-owned files. */
import type { CourseGraphSettings } from './graph-settings.ts'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
interface ReadingLocation {
  readonly path: string
  readonly anchor: string
}
interface CourseView {
  history: ReadingLocation[]
  historyIndex: number
  rightOpen: boolean
  rightTab: 'outline' | 'links' | 'graph' | 'tutor'
  graphSettings: Record<string, CourseGraphSettings>
  graphSettingsOpen: boolean
  graphSettingsFailed: boolean
  graphPlaying: boolean
  graphAnimationRevision: number
  folderStates: Record<string, readonly string[]>
  studyPending: boolean
  selectedId: string
  searchOpen: boolean
  catalogQuery: string
  search: string
  path: string
  anchor: string
  creating: boolean
  unsaved: boolean
  revision: number
  navigationRevision: number
  tutorSession: string | null
  notice: string
  quotePreview: string
}
type CourseActions = {
  patch: (draft: CourseView, value: Partial<CourseView>) => void
  navigate: (draft: CourseView, location: ReadingLocation) => void
  travel: (draft: CourseView, direction: -1 | 1) => void
}
/**
 * Create one shared course selection store.
 * @returns A store handle for the course sidebar and reading panel.
 */
export function createCourseViewStore(): EngineStoreHandle<CourseView, CourseActions> {
  return defineStore({
    init: (): CourseView => ({
      history: [],
      historyIndex: -1,
      rightOpen: true,
      rightTab: 'outline',
      graphSettings: {},
      graphSettingsOpen: false,
      graphSettingsFailed: false,
      graphPlaying: false,
      graphAnimationRevision: 0,
      folderStates: {},
      studyPending: false,
      selectedId: '',
      searchOpen: false,
      catalogQuery: '',
      search: '',
      path: '课程首页.md',
      anchor: '',
      creating: true,
      unsaved: false,
      revision: 0,
      navigationRevision: 0,
      tutorSession: null,
      notice: '',
      quotePreview: '',
    }),
    actions: {
      navigate: (draft, location) => {
        const revision = draft.revision + (draft.path !== location.path || draft.unsaved ? 1 : 0)
        if (draft.history.length === 0 && draft.path !== '') {
          draft.history = [{ path: draft.path, anchor: draft.anchor }]
          draft.historyIndex = 0
        }
        if (draft.path !== location.path || draft.anchor !== location.anchor) {
          draft.history = draft.history.slice(0, draft.historyIndex + 1)
          draft.history.push(location)
          draft.historyIndex = draft.history.length - 1
        }
        Object.assign(draft, location, {
          unsaved: false,
          notice: '',
          revision,
          navigationRevision: draft.navigationRevision + 1,
        })
      },
      travel: (draft, direction) => {
        const index = draft.historyIndex + direction
        const location = draft.history[index]
        if (index < 0 || location === undefined) return
        const revision = draft.revision + (draft.path !== location.path || draft.unsaved ? 1 : 0)
        draft.historyIndex = index
        Object.assign(draft, location, {
          unsaved: false,
          notice: '',
          revision,
          navigationRevision: draft.navigationRevision + 1,
        })
      },
      patch: (draft, value) => {
        if (value.selectedId !== undefined && value.selectedId !== draft.selectedId) {
          draft.history = []
          draft.historyIndex = -1
          draft.path = ''
          draft.anchor = ''
        }
        Object.assign(draft, value)
      },
    },
  })
}
