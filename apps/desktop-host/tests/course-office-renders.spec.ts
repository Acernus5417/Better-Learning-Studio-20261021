import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareOfficeRenders } from '../src/course-office-renders.ts'
import { runCourseScript } from '../src/course-stage-verifier.ts'

vi.mock('../src/course-stage-verifier.ts', () => ({ runCourseScript: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.mocked(runCourseScript).mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(format: 'docx' | 'pptx', parts: string[], slideOrder: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'bls-office-map-'))
  roots.push(root)
  const original = join(root, '原始资料')
  await mkdir(original)
  const sourcePath = join(original, `source.${format}`)
  await writeFile(sourcePath, 'source')
  const sha256 = 'a'.repeat(64)
  const render = join(root, '_工作区', 'office渲染', `SRC-001-${sha256.slice(0, 12)}-saved`)
  await mkdir(render, { recursive: true })
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const images = []
  for (const page of [1, 2]) {
    const path = join(render, `page-${page}.png`)
    await writeFile(path, png)
    images.push({ page, path, byteLength: png.length })
  }
  await writeFile(join(render, 'manifest.json'), JSON.stringify({
    sourceSha256: sha256, pageCount: 2, images, missingFonts: ['Missing Typeface'],
  }))
  vi.mocked(runCourseScript).mockResolvedValue({ sources: [{ id: 'SRC-001', path: sourcePath, sha256,
    format, parts, slide_order: slideOrder }] })
  return { root, images }
}

it('maps every DOCX page and keeps missing font anomalies visible without rerendering', async () => {
  const { root } = await fixture('docx', ['word/document.xml'], [])
  const first = await prepareOfficeRenders({ python: 'unused', scripts: 'unused' }, root)
  expect(first).toEqual({ mapping: '_工作区/office渲染映射.json',
    reports: [{ source: 'SRC-001', pages: 2, missingFonts: ['Missing Typeface'] }] })
  const mapping: unknown = JSON.parse(await readFile(join(root, first.mapping), 'utf8'))
  expect(mapping).toEqual({ 'SRC-001': { 'word/document.xml': [
    '_工作区/office渲染/SRC-001-aaaaaaaaaaaa-saved/page-1.png',
    '_工作区/office渲染/SRC-001-aaaaaaaaaaaa-saved/page-2.png',
  ] } })
  expect(await prepareOfficeRenders({ python: 'unused', scripts: 'unused' }, root)).toEqual(first)
})

it('uses presentation order for slide mapping and refuses a changed cached PNG', async () => {
  const { root, images } = await fixture('pptx', ['ppt/slides/slide1.xml'],
    ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
  const result = await prepareOfficeRenders({ python: 'unused', scripts: 'unused' }, root)
  const mapping: unknown = JSON.parse(await readFile(join(root, result.mapping), 'utf8'))
  expect(mapping).toEqual({ 'SRC-001': { 'ppt/slides/slide1.xml': [
    '_工作区/office渲染/SRC-001-aaaaaaaaaaaa-saved/page-2.png',
  ] } })
  await writeFile(images[1]!.path, 'corrupt')
  await expect(prepareOfficeRenders({ python: 'unused', scripts: 'unused' }, root))
    .rejects.toThrow('bundled renderer is unavailable')
})
