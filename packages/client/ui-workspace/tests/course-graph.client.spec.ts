import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  defaultCourseGraphSettings,
  loadCourseGraphSettings,
  saveCourseGraphSettings,
} from '../src/client/course/graph-settings.ts'

interface Graph {
  nodes: Record<string, { type: string; color: string | null; links: Record<string, boolean> }>
  weights: Record<string, number> | null
}
interface Note {
  path: string
  links: { target: string; resolved: boolean }[]
  tags: string[]
  ctime: number
  isAttachment: boolean
}
interface Builder {
  setNotes(notes: Note[]): Builder
  build(options: Record<string, unknown>): Graph
}
const load = (): {
  GraphDataBuilder: new () => Builder
  SimpleQuery: new (text: string) => { matchFilepath: (path: string) => boolean }
  DEFAULT_OPTIONS: { showOrphans: boolean }
} => {
  const box = { module: { exports: {} } }
  runInNewContext(
    readFileSync(resolve(import.meta.dirname, '../../../../apps/web/public/course-graph/graph-data.js'), 'utf8'),
    box,
  )
  return box.module.exports as ReturnType<typeof load>
}
const note = (path: string, targets: string[] = []): Note => ({
  path,
  links: targets.map(target => ({ target, resolved: true })),
  tags: [],
  ctime: 0,
  isAttachment: false,
})
describe('ported course graph', () => {
  it('cools the supplied physics engine to idle and does not schedule forever for an empty graph', () => {
    const jobs = new Map<number, () => void>()
    let sequence = 0
    const box = {
      self: {
        createSimWorkerProxy: undefined as
          | undefined
          | (() => { postMessage: (message: object) => void; terminate: () => void }),
      },
      setTimeout: (callback: () => void) => {
        jobs.set(++sequence, callback)
        return sequence
      },
      clearTimeout: (id: number) => {
        jobs.delete(id)
      },
    }
    runInNewContext(
      readFileSync(resolve(import.meta.dirname, '../../../../apps/web/public/course-graph/sim-worker.js'), 'utf8'),
      box,
    )
    const make = box.self.createSimWorkerProxy
    if (make === undefined) throw new Error('Missing physics proxy')
    const worker = make()
    const drain = (): number => {
      let ticks = 0
      while (jobs.size > 0 && ticks < 600) {
        const first = jobs.entries().next().value
        if (first === undefined) break
        jobs.delete(first[0])
        first[1]()
        ticks++
      }
      return ticks
    }
    worker.postMessage({
      nodes: { 'file/A.md': [0, 0], 'file/B.md': [100, 0] },
      links: [['file/A.md', 'file/B.md']],
      run: true,
    })
    const ticks = drain()
    expect(ticks).toBeGreaterThan(200)
    expect(ticks).toBeLessThan(400)
    expect(jobs.size).toBe(0)
    worker.postMessage({ nodes: {}, alpha: 0.3, run: true })
    expect(drain()).toBe(1)
    expect(jobs.size).toBe(0)
    worker.terminate()
  })
  it('hides orphan and self-only files by default, retaining real incoming and outgoing neighbors', () => {
    const { GraphDataBuilder, DEFAULT_OPTIONS } = load()
    expect(DEFAULT_OPTIONS.showOrphans).toBe(false)
    const graph = new GraphDataBuilder()
      .setNotes([
        note('file/A.md', ['file/B.md']),
        note('file/B.md'),
        note('file/C.md'),
        note('file/D.md', ['file/D.md']),
      ])
      .build({})
    expect(Object.keys(graph.nodes)).toEqual(['file/A.md', 'file/B.md'])
    expect(graph.nodes['file/A.md']?.links).toEqual({ 'file/B.md': true })
    expect(graph).toMatchSnapshot()
  })
  it('does not retain nodes connected only to filtered-out files', () => {
    const { GraphDataBuilder, SimpleQuery } = load()
    const graph = new GraphDataBuilder()
      .setNotes([note('file/A.md', ['file/B.md']), note('file/B.md')])
      .build({ searchQueries: [{ query: new SimpleQuery('A.md'), color: null }] })
    expect(Object.keys(graph.nodes)).toEqual([])
  })
  it('retains canonical direction in local neighborhoods and supports optional orphan visibility', () => {
    const { GraphDataBuilder } = load(),
      builder = new GraphDataBuilder().setNotes([
        note('file/A.md', ['file/B.md']),
        note('file/B.md'),
        note('file/C.md'),
      ])
    expect(Object.keys(builder.build({ showOrphans: true }).nodes)).toHaveLength(3)
    const graph = builder.build({ localFile: 'file/A.md', localJumps: 1 })
    expect(graph.nodes['file/A.md']?.links['file/B.md']).toBe(true)
    expect(graph.nodes['file/B.md']?.links['file/A.md']).toBeUndefined()
  })
  it('supports tags, attachments, unresolved-link hiding, color groups and progression', () => {
    const { GraphDataBuilder, SimpleQuery } = load()
    const input = note('file/A.md', ['file/B.md', 'file/image.png'])
    input.tags = ['physics']
    input.links.push({ target: 'missing/unknown', resolved: false })
    const image = { ...note('file/image.png'), isAttachment: true }
    const builder = new GraphDataBuilder().setNotes([input, note('file/B.md'), image])
    const graph = builder.build({
      showTags: true,
      showAttachments: true,
      searchQueries: [{ query: new SimpleQuery('A.md'), color: '#8b72dc' }],
    })
    expect(graph.nodes['#physics']?.type).toBe('tag')
    expect(graph.nodes['file/image.png']?.type).toBe('attachment')
    expect(graph.nodes['missing/unknown']?.type).toBe('unresolved')
    expect(graph.nodes['file/A.md']?.color).toBe('#8b72dc')
    expect(builder.build({ hideUnresolved: true }).nodes['missing/unknown']).toBeUndefined()
    expect(Object.keys(builder.build({ progression: 1 }).nodes).length).toBeLessThan(Object.keys(graph.nodes).length)
  })
  it('keeps preferences course-scoped and validates persisted ranges', () => {
    const values = new Map<string, string>(),
      storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
      }
    expect(loadCourseGraphSettings(storage, 'A').showOrphans).toBe(false)
    expect(loadCourseGraphSettings(storage, 'A').lineSizeMultiplier).toBe(0.1)
    expect(loadCourseGraphSettings(storage, 'A').linkStrength).toBe(0.4)
    saveCourseGraphSettings(storage, 'A', {
      ...defaultCourseGraphSettings,
      showOrphans: true,
      lineSizeMultiplier: 0.6,
      linkStrength: 0.7,
      groups: [{ id: 'one', query: 'physics', color: '#8b72dc' }],
    })
    expect(loadCourseGraphSettings(storage, 'A').showOrphans).toBe(true)
    expect(loadCourseGraphSettings(storage, 'A').lineSizeMultiplier).toBe(0.6)
    expect(loadCourseGraphSettings(storage, 'A').linkStrength).toBe(0.7)
    expect(loadCourseGraphSettings(storage, 'B').showOrphans).toBe(false)
    values.set(
      'bls-course-graph-v1:A',
      JSON.stringify({ version: 1, settings: { ...defaultCourseGraphSettings, repelStrength: 999 } }),
    )
    expect(() => loadCourseGraphSettings(storage, 'A')).toThrow('range')
  })
})
