/** Learning action identifiers retained in versioned course selections and Session history. */
export type CourseStudyAction = 'explain' | 'example' | 'summarize' | 'quiz' | 'discuss'

/** Actions admitted by the course learning Session. */
export type ActiveCourseStudyAction = CourseStudyAction

/** The learner-selected action resolves to this installed skill name. */
export function studyActionSkill(action: CourseStudyAction): string {
  return `study-${action}`
}

/**
 * Validate an action arriving through the course HTTP API.
 * @param value - Untrusted action field.
 * @returns Whether the field identifies a known learning action.
 */
export function isCourseStudyAction(value: unknown): value is CourseStudyAction {
  return value === 'explain' || value === 'example' || value === 'summarize' || value === 'quiz' || value === 'discuss'
}
