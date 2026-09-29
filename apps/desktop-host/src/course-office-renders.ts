/** Render Office pages needed by native visual units before transcription prepare. */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { runCourseScript, type CourseVerifierRuntime } from './course-stage-verifier.ts'
import { admittedCourseSourceRoots } from './course-attachments.ts'

const execute = promisify(execFile)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAP = '_工作区/office渲染映射.json'

interface Requirement {
  id: string
  path: string
  sha256: string
  format: 'docx' | 'pptx'
  parts: string[]
  slide_order: string[]
}
interface RenderedImage { page: number; path: string; byteLength: number }
interface Manifest { sourceSha256: string; pageCount: number; images: RenderedImage[]; missingFonts: string[] }
export interface OfficeRenderPreparation {
  mapping: string
  reports: { source: string; pages: number; missingFonts: string[] }[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function requirements(value: unknown): Requirement[] {
  if (!record(value) || !Array.isArray(value.sources)) throw new Error('course office: invalid requirements')
  return value.sources.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !/^SRC-\d{3,}$/u.test(item.id)
      || typeof item.path !== 'string' || !isAbsolute(item.path)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || !['docx', 'pptx'].includes(String(item.format))
      || !Array.isArray(item.parts) || !item.parts.every((part: unknown) => typeof part === 'string')
      || !Array.isArray(item.slide_order) || !item.slide_order.every((part: unknown) => typeof part === 'string')) {
      throw new Error('course office: invalid source requirement')
    }
    return item as unknown as Requirement
  })
}

async function validatedManifest(course: string, directory: string, source: Requirement): Promise<Manifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (!record(value) || value.sourceSha256 !== source.sha256
      || typeof value.pageCount !== 'number' || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1
      || !Array.isArray(value.images) || value.images.length < value.pageCount
      || !Array.isArray(value.missingFonts)
      || !value.missingFonts.every((font: unknown) => typeof font === 'string')) return null
    const images: RenderedImage[] = []
    const pages = new Set<number>()
    for (const raw of value.images) {
      if (!record(raw) || typeof raw.page !== 'number' || !Number.isSafeInteger(raw.page) || raw.page < 1
        || raw.page > value.pageCount || typeof raw.path !== 'string'
        || !isAbsolute(raw.path) || typeof raw.byteLength !== 'number'
        || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 8) return null
      const path = await realpath(raw.path)
      if (!inside(directory, path) || !inside(course, path)) return null
      const size = (await stat(path)).size
      if (size !== raw.byteLength) return null
      const file = await open(path, 'r')
      try {
        const signature = Buffer.alloc(8)
        if ((await file.read(signature, 0, 8, 0)).bytesRead !== 8 || !signature.equals(pngSignature)) return null
      } finally { await file.close() }
      pages.add(raw.page)
      images.push({ page: raw.page, path, byteLength: raw.byteLength })
    }
    if (pages.size !== value.pageCount) return null
    if (source.format === 'pptx' && value.pageCount !== source.slide_order.length) return null
    return { sourceSha256: source.sha256, pageCount: value.pageCount, images,
      missingFonts: value.missingFonts }
  } catch { return null }
}

async function renderSource(
  runtime: CourseVerifierRuntime, course: string, root: string, source: Requirement,
): Promise<{ directory: string; manifest: Manifest }> {
  const prefix = `${source.id}-${source.sha256.slice(0, 12)}-`
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const directory = join(root, entry.name)
    const manifest = await validatedManifest(course, directory, source)
    if (manifest) return { directory, manifest }
  }
  if (!runtime.officeNode || !runtime.officeCli) throw new Error('course office: bundled renderer is unavailable')
  const directory = join(root, prefix + randomUUID())
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)))
  try {
    await execute(runtime.officeNode, [runtime.officeCli, 'render', '--input', source.path,
      '--output-dir', directory, '--dpi', '144', '--max-pages', '10000'], {
      windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024, env,
    })
  } catch (error) {
    throw new Error(`course office: ${source.id} page rendering failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = await validatedManifest(course, directory, source)
  if (!manifest) throw new Error(`course office: ${source.id} render manifest or page coverage is invalid`)
  return { directory, manifest }
}

/** Build an atomic course-relative map; reuse intact renderer output after a crash. */
export async function prepareOfficeRenders(runtime: CourseVerifierRuntime, course: string): Promise<OfficeRenderPreparation> {
  const root = await realpath(course)
  const sources = requirements(await runCourseScript(runtime, root, 'office_render_requirements.py', []))
  const admittedRoots = await admittedCourseSourceRoots(root)
  const renderRoot = join(root, '_工作区', 'office渲染')
  await mkdir(renderRoot, { recursive: true })
  const mapping: Record<string, Record<string, string[]>> = {}
  const reports: OfficeRenderPreparation['reports'] = []
  for (const source of sources) {
    const sourcePath = await realpath(source.path)
    if (!admittedRoots.some(admitted => inside(admitted, sourcePath))) {
      throw new Error(`course office: ${source.id} source is outside admitted materials`)
    }
    const { manifest } = await renderSource(runtime, root, renderRoot, source)
    reports.push({ source: source.id, pages: manifest.pageCount, missingFonts: manifest.missingFonts })
    const paths = (page: number): string[] => manifest.images.filter(image => image.page === page)
      .map(image => relative(root, image.path).split(sep).join('/'))
    const all = Array.from({ length: manifest.pageCount }, (_, i) => paths(i + 1)).flat()
    const sourceMapping: Record<string, string[]> = {}
    mapping[source.id] = sourceMapping
    for (const part of source.parts) {
      const images = source.format === 'pptx' ? paths(source.slide_order.indexOf(part) + 1) : all
      if (images.length === 0) throw new Error(`course office: ${source.id}/${part} has no page image`)
      sourceMapping[part] = images
    }
  }
  const output = join(root, MAP)
  const temporary = `${output}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(mapping, null, 2) + '\n', { flag: 'wx' })
  await rename(temporary, output)
  const reportPath = join(root, '_工作区', 'office渲染报告.json')
  const reportTemporary = `${reportPath}.${randomUUID()}.tmp`
  await writeFile(reportTemporary, JSON.stringify({ sources: reports }, null, 2) + '\n', { flag: 'wx' })
  await rename(reportTemporary, reportPath)
  return { mapping: MAP, reports }
}
