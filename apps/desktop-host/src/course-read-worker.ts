/** Bounded course parser entry; never modifies course material. */
import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { parseCourseDocument, courseReadingTree, presentationBlocks } from '@deepseek-ai/dsh-util-course-document'
import { loadCoursePresentation } from './course-presentation-read.ts'
import type { CourseFileContent } from '@deepseek-ai/dsh-util-course-document'

async function parse(input: unknown): Promise<void> {
  if (input === null || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'number') return
  const id = input.id
  try {
    if (
      !('text' in input) ||
      typeof input.text !== 'string' ||
      Buffer.byteLength(input.text) > 4 * 1024 * 1024 ||
      !('path' in input) ||
      typeof input.path !== 'string' ||
      !('course' in input) ||
      typeof input.course !== 'string'
    )
      throw new Error('Invalid course parser request')
    const text = input.text,
      document = parseCourseDocument(text)
    if ('indexOnly' in input && input.indexOnly === true) {
      const file: CourseFileContent = {
        path: input.path,
        text,
        version: createHash('sha256').update(text).digest('hex'),
        document: { ...document, nodes: [] },
      }
      const cost = text.length * 4 + JSON.stringify(file.document).length * 4
      parentPort?.postMessage({ id, ok: true, file, reading: file, cost })
      return
    }
    const presentation = await loadCoursePresentation(input.course, input.path, text)
    const file: CourseFileContent = {
      path: input.path,
      text,
      version: createHash('sha256').update(text).digest('hex'),
      document,
      ...(presentation === undefined ? {} : { presentation }),
    }
    const blocks = presentation?.annotations.length ? presentationBlocks(text) : []
    const starts = new Map(blocks.map(block => [block.id, block.start]))
    const annotations = (presentation?.annotations ?? []).flatMap((annotation) => {
      const start = starts.get(annotation.block)
      return start === undefined ? [] : [{ start, annotation }]
    })
    const reading: CourseFileContent = {
      ...file,
      document: { ...document, nodes: courseReadingTree(text, document.nodes, presentation) },
      reading: { schemaVersion: 1, annotations },
    }
    const cost = text.length * 4 + JSON.stringify(reading.document).length * 4
    parentPort?.postMessage({ id, ok: true, file, reading, cost })
  } catch (error) {
    parentPort?.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
parentPort?.on('message', (input: unknown) => {
  void parse(input)
})
