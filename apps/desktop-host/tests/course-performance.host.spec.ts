import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, utimes, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CourseLibrary } from '../src/course-library.ts'
import { CourseGraphIndex } from '../src/course-graph-index.ts'
import { parseCourseDocument } from '@deepseek-ai/dsh-util-course-document'
import type { CourseSessionFactory } from '../src/course-library.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CourseFileContent } from '@deepseek-ai/dsh-util-course-document'

const roots: string[] = [],
  owners: CourseLibrary[] = []
const sessions: CourseSessionFactory = {
  workspace: async () => 'test-workspace' as WorkspaceId,
  session: async () => 'test-session' as SessionId,
  sessionValid: async () => true,
}
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bls-performance-'))
  roots.push(root)
  const library = new CourseLibrary(join(root, 'course'), sessions)
  owners.push(library)
  const course = await library.create('performance')
  await library.createFile(course.id, '学习文档/A.md', false)
  return { root, library, course, path: '学习文档/A.md' }
}
it('shares concurrent parses, returns no repeated AST payload and observes same-size external edits', async () => {
  const { root, library, course, path } = await fixture()
  await writeFile(join(root, 'course', course.id, path), '# Same\n\nalpha')
  const values = await Promise.all(Array.from({ length: 12 }, () => library.read(course.id, path)))
  expect(library.reads.metrics.parses).toBe(1)
  await library.createFile(course.id, '学习文档/B.md', false)
  await library.read(course.id, '学习文档/B.md')
  const beforeInvalidation = library.reads.metrics.parses
  library.reads.invalidate(join(root, 'course', course.id), '学习文档/B.md')
  await library.read(course.id, path)
  expect(library.reads.metrics.parses).toBe(beforeInvalidation)
  expect(new Set(values.map(value => value.version)).size).toBe(1)
  const first = await library.view('read', course.id, path, '')
  expect(first.value).toBeDefined()
  const again = await library.view('read', course.id, path, first.revision)
  expect(again).toEqual({ revision: first.revision })
  expect(library.reads.metrics.parses).toBe(beforeInvalidation)
  await writeFile(join(root, 'course', course.id, path), '# Same\n\nbravo')
  const changed = await library.view('read', course.id, path, first.revision)
  expect(changed.revision).not.toBe(first.revision)
  await expect(library.save(course.id, path, 'overwrite', values[0]!.version)).rejects.toThrow('changed on disk')
  await expect(library.quote(course.id, path, values[0]!.version, 0, 4)).rejects.toThrow('stale')
  expect((await library.read(course.id, path)).text).toContain('bravo')
})
it('reuses persistent metadata across owners and removes deleted search results', async () => {
  const { root, library, course, path } = await fixture()
  await library.createFile(course.id, '学习文档/B.md', false)
  await writeFile(join(root, 'course', course.id, path), '# Alpha\n\n[[B]] indexneedle')
  await library.graph(course.id)
  await library.links(course.id)
  await library.search(course.id, 'indexneedle')
  const parses = library.reads.metrics.parses
  await library.graph(course.id)
  await library.links(course.id)
  await library.search(course.id, 'indexneedle')
  expect(library.reads.metrics.parses).toBe(parses)
  library.dispose()
  const next = new CourseLibrary(join(root, 'course'), sessions)
  owners.push(next)
  expect((await next.search(course.id, 'indexneedle')).map(item => item.path)).toEqual([path])
  expect(next.reads.metrics.parses).toBe(0)
  await next.trash(course.id, path)
  expect(await next.search(course.id, 'indexneedle')).toEqual([])
  const db = new DatabaseSync(join(root, 'course', course.id, '.studio/index/course.sqlite'))
  expect(db.prepare('SELECT path FROM documents WHERE path=?').get(path)).toBeUndefined()
  db.close()
})
it('rebuilds malformed derived rows and keeps identically named files scoped to their own course', async () => {
  const { root, library, course, path } = await fixture()
  const other = await library.create('Other')
  await library.createFile(other.id, path, false)
  await writeFile(join(root, 'course', course.id, path), '# Own course\n\nlocalneedle')
  await writeFile(join(root, 'course', other.id, path), '# Other course\n\nforeignneedle')
  await library.search(course.id, 'localneedle')
  const db = new DatabaseSync(join(root, 'course', course.id, '.studio/index/course.sqlite'))
  db.prepare('UPDATE documents SET metadata=? WHERE path=?').run('{broken', path)
  db.close()
  expect((await library.search(course.id, 'localneedle')).length).toBe(1)
  expect(await library.search(course.id, 'foreignneedle')).toEqual([])
  const controller = new AbortController()
  controller.abort()
  await expect(library.graph(course.id, controller.signal)).rejects.toThrow()
})
it('prepares safe reading disclosures off-thread while retaining the canonical raw document', async () => {
  const { root, library, course, path } = await fixture()
  await writeFile(
    join(root, 'course', course.id, path),
    '# Topic\n\n<details><summary>Answer</summary>\n\n$x^2$\n\n</details>',
  )
  await library.graph(course.id)
  const raw = await library.read(course.id, path)
  expect(raw.document.nodes.length).toBeGreaterThan(0)
  expect(raw.reading).toBeUndefined()
  const packet = await library.view('read', course.id, path, '')
  expect(packet.value).toMatchObject({ file: { reading: { schemaVersion: 1 } } })
  const value = packet.value as { file: CourseFileContent }
  expect(value.file.document.nodes.some(node => node.type === 'details')).toBe(true)
  expect(raw.text).toContain('<details>')
})

it('reuses content metadata for copies, timestamp changes and renamed paths across owners', async () => {
  const { root, library, course, path } = await fixture()
  const folder = join(root, 'course', course.id)
  await writeFile(join(folder, path), '# Shared\n\n[[B]]')
  await library.graph(course.id)
  const parsed = library.reads.metrics.parses
  await library.createFile(course.id, '学习文档/B.md', false)
  await writeFile(join(folder, '学习文档/B.md'), '# Shared\n\n[[B]]')
  const copied = await library.graph(course.id)
  expect(library.reads.metrics.parses).toBe(parsed)
  expect(copied.notes.find(note => note.path === path)?.links).toEqual([{ target: '学习文档/B.md', resolved: true }])
  library.dispose()
  const next = new CourseLibrary(join(root, 'course'), sessions)
  owners.push(next)
  const future = new Date(Date.now() + 10000)
  await utimes(join(folder, path), future, future)
  await rename(join(folder, '学习文档/B.md'), join(folder, '学习文档/C.md'))
  const renamed = await next.graph(course.id)
  expect(next.reads.metrics.parses).toBe(0)
  expect(renamed.notes.find(note => note.path === path)?.links).toEqual([{ target: 'B', resolved: false }])
})

it('invalidates only references to changed names and preserves unrelated relationships', () => {
  const index = new CourseGraphIndex()
  const file = (path: string, text: string): CourseFileContent => ({
    path,
    text,
    version: text,
    document: parseCourseDocument(text),
  })
  const a = file('one/A.md', '[[B]] [[Missing]]'),
    c = file('C.md', '[[D]]')
  index.updateInventory(['one/A.md', 'one/B.md', 'C.md', 'D.md'])
  expect(index.project(a).links[0]).toEqual({ target: 'one/B.md', resolved: true })
  const other = index.project(c),
    resolutions = index.metrics.resolutions
  index.project(a)
  expect(index.metrics.resolutions).toBe(resolutions)
  index.updateInventory(['one/A.md', 'one/B.md', 'C.md', 'D.md', 'Missing.md', 'two/B.md'])
  expect(index.project(c)).toBe(other)
  expect(index.metrics.resolutions).toBe(resolutions)
  expect(index.project(a).links).toEqual([
    { target: 'one/B.md', resolved: true },
    { target: 'Missing.md', resolved: true },
  ])
  index.updateInventory(['one/A.md', 'C.md', 'D.md', 'Missing.md', 'two/B.md'])
  expect(index.project(a).links[0]).toEqual({ target: 'two/B.md', resolved: true })
})
