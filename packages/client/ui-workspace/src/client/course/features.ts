/** Reserved course capabilities. Graph data stays portable and its product surface is course-scoped. */
export const courseReadingCapabilities = { outline: true, backlinks: true, graph: true } as const

/** Course reference-panel registration keys. */
export type CourseReferenceCapability = keyof typeof courseReadingCapabilities
