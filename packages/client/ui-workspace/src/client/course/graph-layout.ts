/** Admit bounded layout messages from the current course-owned graph frame. */
import type { CourseGraphLayout } from '@deepseek-ai/dsh-util-course-document'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9
/**
 * Validate layout messages against the current course.
 * @param value - Untrusted frame message payload.
 * @param paths - File paths currently admitted by the parent.
 * @returns Whether the payload contains only bounded course-local layout hints.
 */
export function isCourseGraphLayout(value: unknown, paths: ReadonlySet<string>): value is CourseGraphLayout {
  if (!record(value) || !Array.isArray(value.positions) || value.positions.length > 5000) return false
  if (
    !value.positions.every(
      (point: unknown) =>
        record(point) &&
        typeof point.path === 'string' &&
        paths.has(point.path) &&
        coordinate(point.x) &&
        coordinate(point.y),
    )
  )
    return false
  if (value.view === undefined) return true
  return (
    record(value.view) &&
    coordinate(value.view.scale) &&
    value.view.scale >= 1 / 128 &&
    value.view.scale <= 8 &&
    coordinate(value.view.centerX) &&
    coordinate(value.view.centerY)
  )
}
