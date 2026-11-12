/** Bounded, rebuildable graph snapshots stored separately from source documents and Sessions. */
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { CourseGraphData, CourseGraphLayout } from '@deepseek-ai/dsh-util-course-document'

const coordinate = z.number().min(-1e9).max(1e9)
const path = z.string().min(1).max(1000)
const layoutSchema = z.object({
  positions: z.array(z.object({ path, x: coordinate, y: coordinate })).max(5000),
  view: z
    .object({
      scale: z
        .number()
        .min(1 / 128)
        .max(8),
      centerX: coordinate,
      centerY: coordinate,
    })
    .optional(),
})
const schema = z.object({
  schema: z.literal(2),
  courseId: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  graph: z.object({
    notes: z
      .array(
        z.object({
          path,
          links: z.array(z.object({ target: z.string().max(4096), resolved: z.boolean() })).max(50000),
          tags: z.array(z.string().max(4096)).max(50000),
          ctime: z.number(),
          isAttachment: z.boolean(),
        }),
      )
      .max(5000),
  }),
  layout: layoutSchema.optional(),
})
/** Complete derived metadata with an optional last-known camera and positions. */
export interface CourseGraphSnapshot {
  readonly schema: 2
  readonly courseId: string
  readonly revision: string
  readonly graph: CourseGraphData
  readonly layout?: CourseGraphLayout
}
/** Validate layout messages. @param value - Untrusted frame coordinates. @returns Bounded layout hints. */
export function parseGraphLayout(value: unknown): CourseGraphLayout {
  const { view, ...layout } = layoutSchema.parse(value)
  return { ...layout, ...(view === undefined ? {} : { view }) }
}
/**
 * Read a derived snapshot; invalid or obsolete data is rebuildable.
 * @param directory - Admitted private cache directory.
 * @param courseId - Expected managed course identity.
 * @returns A validated snapshot or no usable cache.
 */
export async function readGraphSnapshot(directory: string, courseId: string): Promise<CourseGraphSnapshot | undefined> {
  const target = join(directory, 'graph.json')
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return
    const result = schema.safeParse(JSON.parse(await readFile(target, 'utf8')))
    if (!result.success || result.data.courseId !== courseId) return
    if (createHash('sha256').update(JSON.stringify(result.data.graph)).digest('hex') !== result.data.revision) return
    const edges = result.data.graph.notes.reduce((sum, note) => sum + note.links.length + note.tags.length, 0)
    if (edges > 50000) return
    const { layout, ...snapshot } = result.data
    return { ...snapshot, ...(layout === undefined ? {} : { layout: parseGraphLayout(layout) }) }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      console.warn(
        'course graph: ignoring an unreadable derived snapshot',
        error instanceof Error ? error.name : 'invalid data',
      )
    return undefined
  }
}
/**
 * Atomically publish derived data without following destination links.
 * @param directory - Admitted private cache directory.
 * @param snapshot - Verified metadata and optional layout hints.
 */
export async function writeGraphSnapshot(directory: string, snapshot: CourseGraphSnapshot): Promise<void> {
  const target = join(directory, 'graph.json'),
    text = JSON.stringify(snapshot)
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) return
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe graph snapshot destination')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
}
