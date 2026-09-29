/** Import only durable attachments from a direct human Session message. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CourseVerifierRuntime } from './course-stage-verifier.ts'
import { runCourseInventory } from './course-stage-verifier.ts'

interface ImportedAttachment {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly bytes: number
}

interface ImportLedger {
  readonly schemaVersion: 1
  readonly entries: readonly ImportedAttachment[]
  readonly folders: readonly string[]
}

function digestFromId(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(id)
  if (match === null) throw new Error('course attachments: invalid durable attachment ID')
  const digest = match[1]
  if (digest === undefined) throw new Error('course attachments: missing digest')
  return digest
}

function filename(name: string | undefined, digest: string, image: boolean): string {
  const clean = (name ?? (image ? 'image.png' : 'file'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/gu, '').slice(0, 100)
  return `${digest}-${clean || (image ? 'image.png' : 'file')}`
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('course attachments: unexpected file stream chunk')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function ledgerAt(path: string): Promise<ImportLedger> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || !('schemaVersion' in value)
      || value.schemaVersion !== 1 || !('entries' in value) || !Array.isArray(value.entries)
      || !('folders' in value) || !Array.isArray(value.folders)
      || !value.folders.every((folder: unknown) => typeof folder === 'string')
      || !value.entries.every((entry: unknown) => typeof entry === 'object' && entry !== null
        && 'id' in entry && typeof entry.id === 'string'
        && 'path' in entry && typeof entry.path === 'string'
        && 'name' in entry && typeof entry.name === 'string'
        && 'bytes' in entry && typeof entry.bytes === 'number')) {
      throw new Error('course attachments: invalid import ledger')
    }
    return value as ImportLedger
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { schemaVersion: 1, entries: [], folders: [] }
    }
    throw error
  }
}

async function saveLedger(path: string, ledger: ImportLedger): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(ledger, null, 2), { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function withinSource(sourceRoot: string, path: string): boolean {
  const child = relative(sourceRoot, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** Path tokens are taken from an actual human message, never model arguments. */
export function humanFolderMentions(content: readonly ContentBlock[], cwd: string): string[] {
  const folders = new Set<string>()
  for (const block of content) {
    if (block.type !== 'text') continue
    const pattern = /(?:^|\s)@(?:"([^"\r\n]+)"|([^\s"'<>]+))/gu
    for (const match of block.text.matchAll(pattern)) {
      const token = match[1] ?? match[2]
      if (token?.endsWith('/') !== true) continue
      const path = token.slice(0, -1)
      if (path !== '') folders.add(resolve(cwd, path))
    }
  }
  return [...folders]
}

async function verifiedExisting(path: string, digest: string, bytes: number): Promise<boolean> {
  try { return (await stat(path)).size === bytes && await fileDigest(path) === digest }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Import admitted files/images into the course's immutable source area, then
 * inventory exactly the registered imported paths. Never trust a model path.
 */
export async function importCourseAttachments(
  course: string, content: readonly ContentBlock[], attachments: AttachmentStore,
  runtime: CourseVerifierRuntime, cwd = course,
): Promise<{ imported: readonly string[]; folders: readonly string[]; sources: number } | null> {
  const refs = content.filter((part): part is Extract<ContentBlock, { type: 'file' | 'image' }> =>
    part.type === 'file' || part.type === 'image')
  const mentionedFolders = humanFolderMentions(content, cwd)
  if (refs.length === 0 && mentionedFolders.length === 0) return null
  const sourceRoot = join(course, '原始资料')
  const ledgerPath = join(course, '_工作区', '附件导入.json')
  await mkdir(sourceRoot, { recursive: true })
  if (relative(await realpath(course), await realpath(sourceRoot)) !== '原始资料') {
    throw new Error('course attachments: source directory resolves outside the course')
  }
  await mkdir(join(course, '_工作区'), { recursive: true })
  const previous = await ledgerAt(ledgerPath)
  const entries = [...previous.entries]
  const folders = new Set(previous.folders)
  const imported: string[] = []
  for (const folder of mentionedFolders) {
    const directory = await realpath(folder)
    if (!(await stat(directory)).isDirectory()) throw new Error('course attachments: referenced folder is not a directory')
    const courseBelow = relative(directory, course)
    if (courseBelow === '' || withinSource(directory, course)) {
      throw new Error('course attachments: source folder cannot contain the output course')
    }
    folders.add(directory)
  }
  for (const block of refs) {
    const ref: FileAttachmentRef | ImageAttachmentRef = block.attachment
    const id = String(ref.attachmentId)
    const digest = digestFromId(id)
    const existing = entries.find(entry => entry.id === id)
    const path = existing?.path ?? join(sourceRoot, filename(ref.name, digest, block.type === 'image'))
    if (resolve(path) !== path || !withinSource(sourceRoot, path)) {
      throw new Error('course attachments: import ledger path escapes source directory')
    }
    if (!await verifiedExisting(path, digest, ref.bytes)) {
      if (existing !== undefined) throw new Error('course attachments: an imported source changed or disappeared')
      const temporary = join(sourceRoot, `.import-${randomUUID()}.tmp`)
      try {
        if (block.type === 'file') {
          await pipeline(Readable.from(attachments.readFileStream(block.attachment)),
            createWriteStream(temporary, { flags: 'wx' }))
        } else {
          const stored = await attachments.readImage(block.attachment)
          await writeFile(temporary, stored.data, { flag: 'wx' })
        }
        if (!await verifiedExisting(temporary, digest, ref.bytes)) {
          throw new Error('course attachments: imported content failed integrity verification')
        }
        try { await link(temporary, path) }
        catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
            && await verifiedExisting(path, digest, ref.bytes))) throw error
        }
      } finally {
        await rm(temporary, { force: true })
      }
    }
    if (existing === undefined) {
      entries.push({ id, name: ref.name ?? (block.type === 'image' ? 'image.png' : 'file'), path, bytes: ref.bytes })
      imported.push(path)
    }
  }
  for (const entry of entries) {
    if (resolve(entry.path) !== entry.path || !withinSource(sourceRoot, entry.path)
      || !await verifiedExisting(entry.path, digestFromId(entry.id), entry.bytes)) {
      throw new Error('course attachments: registered source failed integrity verification')
    }
  }
  await saveLedger(ledgerPath, { schemaVersion: 1, entries, folders: [...folders] })
  const result = await runCourseInventory(runtime, course, [
    ...entries.map(entry => entry.path), ...folders,
  ])
  return { imported, folders: [...folders], sources: result.sources }
}
