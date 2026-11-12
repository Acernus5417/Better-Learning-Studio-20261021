/** Versioned per-course graph preferences, independent of generation and tutor Sessions. */
export interface CourseGraphSettings {
  readonly search: string
  readonly showTags: boolean
  readonly showAttachments: boolean
  readonly hideUnresolved: boolean
  readonly showOrphans: boolean
  readonly groups: readonly { readonly id: string; readonly query: string; readonly color: string }[]
  readonly showArrow: boolean
  readonly textFadeMultiplier: number
  readonly nodeSizeMultiplier: number
  readonly lineSizeMultiplier: number
  readonly highlightColor: string
  readonly centerStrength: number
  readonly repelStrength: number
  readonly linkStrength: number
  readonly linkDistance: number
  readonly local: boolean
  readonly localJumps: number
  readonly localForelinks: boolean
  readonly localBacklinks: boolean
  readonly localInterlinks: boolean
}
/** Course defaults favor thin links, gentler attraction and connected files. */
export const defaultCourseGraphSettings: CourseGraphSettings = {
  search: '',
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: false,
  groups: [],
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 0.1,
  highlightColor: '',
  centerStrength: 0.1,
  repelStrength: 10,
  linkStrength: 0.4,
  linkDistance: 250,
  local: false,
  localJumps: 1,
  localForelinks: true,
  localBacklinks: true,
  localInterlinks: false,
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
/**
 * Read optional display preferences; invalid versions cannot override safe defaults.
 * @param storage - Browser-owned preference store.
 * @param id - Managed course identity.
 * @returns Bounded settings for this course only.
 */
export function loadCourseGraphSettings(storage: Pick<Storage, 'getItem'>, id: string): CourseGraphSettings {
  const raw = storage.getItem(`bls-course-graph-v1:${id}`)
  if (raw === null) return defaultCourseGraphSettings
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.version !== 1 || !object(value.settings))
    throw new Error('Invalid course graph preferences')
  const row = value.settings,
    result = { ...defaultCourseGraphSettings }
  for (const key of [
    'showTags',
    'showAttachments',
    'hideUnresolved',
    'showOrphans',
    'showArrow',
    'local',
    'localForelinks',
    'localBacklinks',
    'localInterlinks',
  ] as const) {
    if (typeof row[key] !== 'boolean') throw new Error('Invalid graph switch')
    result[key] = row[key]
  }
  const limits = {
    textFadeMultiplier: [0, 3],
    nodeSizeMultiplier: [0.1, 5],
    lineSizeMultiplier: [0.1, 5],
    centerStrength: [0, 1],
    repelStrength: [0, 20],
    linkStrength: [0, 1],
    linkDistance: [30, 500],
    localJumps: [1, 4],
  } as const
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const number = row[key],
      [min, max] = limits[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max)
      throw new Error('Invalid graph range')
    result[key] = number
  }
  if (
    typeof row.search !== 'string' ||
    row.search.length > 500 ||
    typeof row.highlightColor !== 'string' ||
    (row.highlightColor !== '' && !/^#[\da-f]{6}$/iu.test(row.highlightColor)) ||
    !Array.isArray(row.groups) ||
    row.groups.length > 24
  )
    throw new Error('Invalid graph filters')
  result.search = row.search
  result.highlightColor = row.highlightColor
  const groups: { id: string; query: string; color: string }[] = []
  for (const group of row.groups as readonly unknown[]) {
    if (
      !object(group) ||
      typeof group.id !== 'string' ||
      typeof group.query !== 'string' ||
      group.query.length > 500 ||
      typeof group.color !== 'string' ||
      !/^#[\da-f]{6}$/iu.test(group.color)
    )
      throw new Error('Invalid graph color group')
    groups.push({ id: group.id, query: group.query, color: group.color })
  }
  return { ...result, groups }
}
/**
 * Save only this course's bounded view settings; callers own visible write failure reporting.
 * @param storage - Browser-owned preference store.
 * @param id - Managed course identity.
 * @param settings - Typed display state.
 */
export function saveCourseGraphSettings(
  storage: Pick<Storage, 'setItem'>,
  id: string,
  settings: CourseGraphSettings,
): void {
  storage.setItem(`bls-course-graph-v1:${id}`, JSON.stringify({ version: 1, settings }))
}
