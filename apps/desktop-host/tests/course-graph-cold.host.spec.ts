import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CourseLibrary } from '../src/course-library.ts'
import { CourseGraphIndex } from '../src/course-graph-index.ts'
import { graphPropertyLinks } from '../src/course-graph-links.ts'
import { readGraphSnapshot } from '../src/course-graph-cache.ts'
import { CourseReadBatch } from '../src/course-read-batch.ts'
import { parseCourseDocument, resolveCourseLink } from '@deepseek-ai/dsh-util-course-document'
import type { CourseFileContent, CourseGraphData, CourseGraphLayout } from '@deepseek-ai/dsh-util-course-document'
import type { CourseSessionFactory } from '../src/course-library.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
  const root = await mkdtemp(join(tmpdir(), 'bls-graph-cold-'))
  roots.push(root)
  const library = new CourseLibrary(join(root, 'course'), sessions)
  owners.push(library)
  const course = await library.create('graph'),
    folder = join(root, 'course', course.id)
  await mkdir(join(folder, '学习文档'), { recursive: true })
  await writeFile(join(folder, '学习文档/A.md'), '# A\n\n[[B]]')
  await writeFile(join(folder, '学习文档/B.md'), '# B\n\n[[A]]')
  return { root, library, course, folder }
}
const document = (path: string, text: string): CourseFileContent => ({
  path,
  text,
  version: text,
  document: parseCourseDocument(text),
})

it('uses one admitted directory scan for warm metadata and skips private work before traversal', async () => {
  const { library, course, folder } = await fixture()
  await mkdir(join(folder, '_工作区/deep'), { recursive: true })
  await writeFile(join(folder, '_工作区/deep/foreign.md'), '[[secret]]')
  await library.graph(course.id)
  const before = { ...library.reads.metrics }
  const graph = await library.graph(course.id)
  expect(graph.notes).toHaveLength(2)
  expect(library.graphProfile).toMatchObject({ files: 2, parsed: 0 })
  expect(library.graphProfile?.paths).toBeLessThanOrEqual(8)
  expect(library.graphProfile?.stats).toBe(library.graphProfile?.paths)
  expect(library.graphProfile?.directoryHits).toBeGreaterThanOrEqual(2)
  expect(library.reads.metrics.parses).toBe(before.parses)
  expect(library.reads.metrics.bytesRead).toBe(before.bytesRead)
})

it('returns a persistent graph and layout immediately, then verifies changed source in the next request', async () => {
  const { library, course, folder, root } = await fixture()
  await library.graph(course.id)
  const layout: CourseGraphLayout = {
    positions: [{ path: '学习文档/A.md', x: 120, y: 340 }],
    view: { scale: 0.5, centerX: 12, centerY: 34 },
  }
  await library.saveGraphLayout(course.id, layout)
  library.dispose()
  await writeFile(join(folder, '学习文档/A.md'), '# New A\n\n[[Missing]]')
  const reopened = new CourseLibrary(join(root, 'course'), sessions)
  owners.push(reopened)
  const cached = await reopened.view('graph', course.id, '', '')
  expect(cached.revision).toMatch(/^pending:/u)
  expect(cached.value).toMatchObject({
    graphPending: true,
    graphLayout: layout,
  })
  expect(
    (cached.value as { graph: CourseGraphData }).graph.notes.find(note => note.path === '学习文档/A.md')?.links,
  ).toEqual([{ target: '学习文档/B.md', resolved: true }])
  const current = await reopened.view('graph', course.id, '', cached.revision)
  expect(current.revision).not.toMatch(/^pending:/u)
  expect(
    (current.value as { graph: CourseGraphData }).graph.notes.find(note => note.path === '学习文档/A.md')?.links,
  ).toEqual([{ target: 'Missing', resolved: false }])
  expect(current.value).not.toHaveProperty('graphPending')
  expect(await reopened.view('graph', course.id, '', current.revision)).toEqual({ revision: current.revision })
  expect(reopened.reads.metrics.parses).toBe(1)
})

it('ignores malformed snapshots and bounds layout messages to files in the course graph', async () => {
  const { library, course, folder } = await fixture()
  await library.graph(course.id)
  await expect(
    library.saveGraphLayout(course.id, { positions: [{ path: '学习文档/A.md', x: NaN, y: 0 }] }),
  ).rejects.toThrow()
  await library.saveGraphLayout(course.id, {
    positions: [
      { path: '../other/A.md', x: 1, y: 2 },
      { path: '学习文档/A.md', x: 3, y: 4 },
    ],
  })
  const saved: unknown = JSON.parse(await readFile(join(folder, '.studio/index/graph.json'), 'utf8'))
  expect(saved).toMatchObject({ layout: { positions: [{ path: '学习文档/A.md', x: 3, y: 4 }] } })
  const original = await readFile(join(folder, '.studio/index/graph.json'), 'utf8')
  await writeFile(join(folder, '.studio/index/graph.json'), original.replace('学习文档/A.md', '学习文档/Tampered.md'))
  expect(await readGraphSnapshot(join(folder, '.studio/index'), course.id)).toBeUndefined()
  await writeFile(join(folder, '.studio/index/graph.json'), '{broken')
  const next = new CourseLibrary(join(folder, '..'), sessions)
  owners.push(next)
  const result = await next.view('graph', course.id, '', '')
  expect(result.revision).not.toMatch(/^pending:/u)
  expect(result.value).toHaveProperty('graph')
})

it('coalesces background indexing and creates a reusable snapshot without a graph view', async () => {
  const { library, course, folder } = await fixture()
  library.scheduleGraph(course.id, 5)
  library.scheduleGraph(course.id, 5)
  library.scheduleGraph(course.id, 5)
  await vi.waitFor(
    async () => {
      expect(await readFile(join(folder, '.studio/index/graph.json'), 'utf8')).toContain('"notes"')
    },
    { timeout: 10000 },
  )
  expect(library.reads.metrics.parses).toBe(2)
  const result = await library.view('graph', course.id, '', '')
  expect(result.value).toHaveProperty('graphPending', true)
  await library.view('graph', course.id, '', result.revision)
})

it('never reuses a cached graph through a replaced course-root junction', async () => {
  const { library, course, folder, root } = await fixture()
  await library.graph(course.id)
  const other = join(root, 'outside')
  await mkdir(other)
  await rename(folder, folder + '-moved')
  try {
    await symlink(other, folder, 'junction')
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) return
    throw error
  }
  await expect(library.view('graph', course.id, '', '')).rejects.toThrow()
})

it('rejects a parent redirect even when its prefix was admitted earlier in the same batch', async () => {
  const { library, course, folder, root } = await fixture(),
    batch = await CourseReadBatch.create(folder)
  const safe: unknown = Reflect.get(library, 'safe')
  if (typeof safe !== 'function') throw new Error('Missing path admission method')
  await Reflect.apply(safe, library, [course.id, '学习文档/A.md', false, batch])
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'A.md'), 'foreign')
  await rename(join(folder, '学习文档'), join(folder, 'moved'))
  try {
    await symlink(outside, join(folder, '学习文档'), 'junction')
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) return
    throw error
  }
  await expect(Reflect.apply(safe, library, [course.id, '学习文档/A.md', false, batch])).rejects.toThrow()
})

it('extracts graph-only YAML relations and aliases without changing source-link offsets', () => {
  const a = document('A.md', '---\nrelated: ["[[Gradient Descent]]", {next: "[[B#Topic|label]]"}]\n---\n\n[[B]]')
  const b = document('B.md', '---\naliases: [Gradient Descent]\n---\n\n# B')
  const index = new CourseGraphIndex()
  index.updateInventory(['A.md', 'B.md'], [a, b])
  expect(index.project(a).links).toEqual([{ target: 'B.md', resolved: true }])
  expect(a.document.links).toHaveLength(1)
  expect(a.text.slice(a.document.links[0]!.start, a.document.links[0]!.end)).toBe('B')
  const changed = document('B.md', '---\naliases: [Steepest Descent]\n---\n\n# B')
  index.updateInventory(['A.md', 'B.md'], [a, changed])
  expect(index.project(a).links).toEqual([
    { target: 'B.md', resolved: true },
    { target: 'Gradient Descent', resolved: false },
  ])
  expect(graphPropertyLinks({ related: ['[[X]]', { next: '[[Y#H]]' }] })).toEqual([
    { target: 'X', wiki: true },
    { target: 'Y', wiki: true },
  ])
})

it('ranks graph ambiguity, merges missing names and retains canonical ambiguity for other consumers', () => {
  const a = document('a/A.md', '[[B]] [[Missing]] [[Missing.md]] [[./Missing]]')
  const paths = ['a/A.md', 'a/deep/B.md', 'z/B.md']
  const index = new CourseGraphIndex()
  index.updateInventory(paths, [a])
  expect(index.project(a).links).toEqual([
    { target: 'a/deep/B.md', resolved: true },
    { target: 'Missing', resolved: false },
  ])
  expect(resolveCourseLink(a.path, 'B', paths)).toEqual({ ambiguous: ['a/deep/B.md', 'z/B.md'] })
})

it('includes only referenced attachments and preserves tag spelling', async () => {
  const { library, course, folder } = await fixture()
  await writeFile(join(folder, '学习文档/A.md'), '# A\n\n[[B]] ![[used.png]] #ML')
  await writeFile(join(folder, 'used.png'), 'attachment')
  await writeFile(join(folder, 'unused.png'), 'attachment')
  const graph: CourseGraphData = await library.graph(course.id)
  expect(graph.notes.map(note => note.path)).toContain('used.png')
  expect(graph.notes.map(note => note.path)).not.toContain('unused.png')
  expect(graph.notes.find(note => note.path === '学习文档/A.md')?.tags).toEqual(['ML'])
})
