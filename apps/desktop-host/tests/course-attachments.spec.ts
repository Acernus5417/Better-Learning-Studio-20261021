import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { humanFolderMentions, importCourseAttachments, refreshCourseInventory } from '../src/course-attachments.ts'
import { runCourseInventory } from '../src/course-stage-verifier.ts'

vi.mock('../src/course-stage-verifier.ts', () => ({
  runCourseInventory: vi.fn(async (_runtime: unknown, _course: string, paths: readonly string[]) =>
    ({ sources: paths.length })),
}))

const roots: string[] = []
afterEach(async () => {
  vi.mocked(runCourseInventory).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function ref(name: string, data: Uint8Array) {
  return { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    name, bytes: data.byteLength }
}

it('copies only admitted human file and image references, then inventories their saved paths', async () => {
  const course = await mkdtemp(join(tmpdir(), 'bls-attachments-'))
  roots.push(course)
  const pdf = Buffer.from('fixture PDF bytes')
  const image = Buffer.from('fixture image bytes')
  const fileRef = ref('lecture.pdf', pdf)
  const imageRef = ref('diagram.png', image)
  const attachments = {
    async *readFileStream() { yield pdf },
    async readImage() { return { ref: imageRef, data: image } },
  }
  const content = [
    { type: 'text', text: 'Make a course' },
    { type: 'file', attachment: fileRef },
    { type: 'image', attachment: imageRef },
  ]
  const first = await importCourseAttachments(course, content as never, attachments as never, {} as never)
  expect(first).toMatchObject({ sources: 2 })
  expect(first?.imported).toHaveLength(2)
  if (first === null || first.imported[0] === undefined || first.imported[1] === undefined) {
    throw new Error('expected two imported sources')
  }
  expect(await readFile(first.imported[0])).toEqual(pdf)
  expect(await readFile(first.imported[1])).toEqual(image)
  expect(vi.mocked(runCourseInventory).mock.calls[0]?.[2]).toEqual(first?.imported)
  const again = await importCourseAttachments(course, content as never, attachments as never, {} as never)
  expect(again).toEqual({ imported: [], folders: [], sources: 2 })
})

it('inventories a folder explicitly mentioned by the human and rejects one containing the course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bls-attachments-'))
  roots.push(root)
  const course = join(root, 'Course')
  const materials = join(root, 'Materials Set')
  await mkdir(course)
  await mkdir(materials)
  await writeFile(join(materials, 'reading.txt'), 'source')
  const content = [{ type: 'text', text: 'Please use @"Materials Set/" for the course' }]
  expect(humanFolderMentions(content as never, root)).toEqual([materials])
  const result = await importCourseAttachments(course, content as never, {} as never, {} as never, root)
  expect(result).toEqual({ imported: [], folders: [materials], sources: 1 })
  expect(vi.mocked(runCourseInventory).mock.calls[0]?.[2]).toEqual([materials])
  await expect(importCourseAttachments(course, [{ type: 'text', text: 'Use @./' }] as never,
    {} as never, {} as never, root)).rejects.toThrow('cannot contain the output course')
})

it('rejects a changed imported source before refreshing the inventory', async () => {
  const course = await mkdtemp(join(tmpdir(), 'bls-attachments-'))
  roots.push(course)
  const data = Buffer.from('original')
  const attachment = ref('notes.txt', data)
  const store = { async *readFileStream() { yield data } }
  const content = [{ type: 'file', attachment }]
  const first = await importCourseAttachments(course, content as never, store as never, {} as never)
  if (first?.imported[0] === undefined) throw new Error('expected imported source')
  await writeFile(first.imported[0], 'changed!')
  await expect(importCourseAttachments(course, content as never, store as never, {} as never))
    .rejects.toThrow('changed or disappeared')
  expect(vi.mocked(runCourseInventory)).toHaveBeenCalledTimes(1)
})

it('retries inventory from the saved ledger after a script failure without reuploading', async () => {
  const course = await mkdtemp(join(tmpdir(), 'bls-attachments-'))
  roots.push(course)
  const data = Buffer.from('saved material')
  const attachment = ref('material.txt', data)
  const content = [{ type: 'file', attachment }]
  const store = { async *readFileStream() { yield data } }
  vi.mocked(runCourseInventory).mockRejectedValueOnce(new Error('temporary inventory failure'))
  await expect(importCourseAttachments(course, content as never, store as never, {} as never))
    .rejects.toThrow('temporary inventory failure')
  const retried = await refreshCourseInventory(course, {} as never)
  expect(retried.sources).toBe(1)
  expect(vi.mocked(runCourseInventory).mock.calls[1]?.[2]).toHaveLength(1)
})

it('resumes a partly copied human attachment batch after interruption', async () => {
  const course = await mkdtemp(join(tmpdir(), 'bls-attachments-'))
  roots.push(course)
  const files = new Map([
    ['first.pdf', Buffer.from('first material')],
    ['second.docx', Buffer.from('second material')],
  ])
  const content = [...files].map(([name, data]) => ({ type: 'file', attachment: ref(name, data) }))
  const reads = new Map<string, number>()
  const store = {
    async *readFileStream(attachment: { name: string }) {
      const count = (reads.get(attachment.name) ?? 0) + 1
      reads.set(attachment.name, count)
      if (attachment.name === 'second.docx' && count === 1) throw new Error('stream interrupted')
      yield files.get(attachment.name)!
    },
  }
  await expect(importCourseAttachments(course, content as never, store as never, {} as never))
    .rejects.toThrow('stream interrupted')
  const ledgerPath = join(course, '_工作区', '附件导入.json')
  const interrupted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
    pending?: { refs: unknown[] }
    entries: unknown[]
  }
  expect(interrupted.pending?.refs).toHaveLength(2)
  expect(interrupted.entries).toHaveLength(0)
  expect(vi.mocked(runCourseInventory)).not.toHaveBeenCalled()

  await expect(refreshCourseInventory(course, {} as never, store as never)).resolves.toEqual({ sources: 2 })
  const resumed = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
    pending?: unknown
    entries: { path: string }[]
  }
  expect(resumed.pending).toBeUndefined()
  expect(resumed.entries).toHaveLength(2)
  expect(reads.get('first.pdf')).toBe(1)
  expect(reads.get('second.docx')).toBe(2)
  expect(await Promise.all(resumed.entries.map(entry => readFile(entry.path))))
    .toEqual([...files.values()])
})
