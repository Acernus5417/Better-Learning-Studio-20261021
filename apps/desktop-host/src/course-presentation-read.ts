/** Read-only portable presentation metadata; safe to load in the course parser Worker. */
import { createHash } from 'node:crypto'
import { readFile, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { readCoursePresentation } from '@deepseek-ai/dsh-util-course-document'
import type { CoursePresentation } from '@deepseek-ai/dsh-util-course-document'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Check every path component of private portable metadata; never follow imported symlinks.
 * @param course - Admitted course folder.
 * @param path - Course-relative Markdown path used only as a hashed metadata key.
 * @param create - Whether publication may create its metadata directories.
 * @returns Owned manifest path.
 */
export async function coursePresentationPath(course: string, path: string, create = false): Promise<string> {
  let current = course
  for (const part of ['.betterlearning', 'presentation']) {
    current = join(current, part)
    if (create) await mkdir(current, { recursive: true })
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('presentation: metadata directory is not owned')
  }
  const target = join(current, sha(path) + '.json')
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('presentation: metadata file cannot be a symlink')
  } catch (error) {
    if (!object(error) || error.code !== 'ENOENT') throw error
  }
  return target
}

/**
 * Load optional metadata; malformed or stale data falls back to the unmodified document.
 * @param course - Admitted course root.
 * @param path - Current document identity.
 * @param source - Current source to rebind after derived relation rebuilds.
 * @returns Approved decorations only, never foreign Sessions or model instructions.
 */
export async function loadCoursePresentation(
  course: string,
  path: string,
  source: string,
): Promise<CoursePresentation | undefined> {
  try {
    const target = await coursePresentationPath(course, path)
    if ((await lstat(target)).size > 1024 * 1024) return
    const value: unknown = JSON.parse(await readFile(target, 'utf8'))
    return readCoursePresentation(value, source)
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return
    console.error('course presentation: basic rendering after metadata read failure', error)
    return undefined
  }
}
