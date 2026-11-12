/** One admitted course file and its resolved or missing local destinations. */
export interface CourseGraphNote {
  readonly path: string
  readonly links: readonly { readonly target: string; readonly resolved: boolean }[]
  readonly tags: readonly string[]
  readonly ctime: number
  readonly isAttachment: boolean
}
/** Course-only graph input; never contains Session or private working files. */
export interface CourseGraphData {
  readonly notes: readonly CourseGraphNote[]
}

/** Rebuildable course-local layout; world coordinates are independent of window size. */
export interface CourseGraphLayout {
  readonly positions: readonly { readonly path: string; readonly x: number; readonly y: number }[]
  readonly view?: { readonly scale: number; readonly centerX: number; readonly centerY: number }
}
