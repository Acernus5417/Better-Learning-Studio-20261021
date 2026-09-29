/** Check course stage outputs with the bundled Python validators and source hashes. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, join } from 'node:path'
import type { CourseStage, CourseStageEvidence, CourseStageVerifier } from './course-workflow.ts'

const execute = promisify(execFile)

/** Absolute runtime paths supplied by the Desktop Host, never by course material. */
export interface CourseVerifierRuntime {
  readonly python: string
  readonly scripts: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rows(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(record) ? value : null
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return record(value) ? value : null
}

async function shaFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('course verifier: unexpected file stream chunk')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function evidence(value: unknown, summary: string): CourseStageEvidence {
  return { signature: createHash('sha256').update(JSON.stringify(value)).digest('hex'), summary }
}

function scriptEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name))), PYTHONDONTWRITEBYTECODE: '1' }
}

/** Run one owned materials-ledger command without exposing process credentials. */
export async function runCourseMaterials(
  runtime: CourseVerifierRuntime, course: string, args: readonly string[],
): Promise<Record<string, unknown>> {
  const { stdout } = await execute(runtime.python, [join(runtime.scripts, 'convert_materials.py'), '--course', course, ...args], {
    windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024, env: scriptEnvironment(),
  })
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || value.error !== undefined || (Array.isArray(value.errors) && value.errors.length > 0)) {
    throw new Error(`course materials: ${args[0] ?? 'command'} returned an invalid or rejected result`)
  }
  return value
}

async function accepted(runtime: CourseVerifierRuntime, course: string, script: string, args: string[]): Promise<boolean> {
  try {
    const { stdout } = await execute(runtime.python, [join(runtime.scripts, script), '--course', course, ...args], {
      windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024,
      env: scriptEnvironment(),
    })
    // The scripts sometimes return a compact report path in bounded mode.
    const result: unknown = JSON.parse(stdout)
    if (!record(result) || result.error !== undefined || result.failure_kind !== undefined
      || result.passed === false || result.complete === false || result.ready === false) return false
    if (Array.isArray(result.errors)) return result.errors.length === 0
    return result.errors === undefined || result.errors === 0
  } catch (error) {
    if (record(error) && typeof error.code === 'number') return false
    throw error
  }
}

/**
 * Run the existing read-only plan validator before creating a native course cursor.
 * A blocking plan is expected for a new course and is returned to the caller.
 * @param runtime - Bundled Python and validation scripts.
 * @param course - Absolute course directory.
 * @returns The validator's persisted checklist and next-action instructions.
 */
export async function inspectCoursePlan(runtime: CourseVerifierRuntime, course: string): Promise<Record<string, unknown>> {
  try {
    await execute(runtime.python, [join(runtime.scripts, 'validate_package.py'), '--course', course, '--mode', 'plan'], {
      windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024,
      env: scriptEnvironment(),
    })
  } catch (error) {
    if (!record(error) || error.code !== 1) throw error
  }
  const result = await json(join(course, '_工作区', '写作前清单.json'))
  if (result?.mode !== 'plan' || typeof result.next !== 'string') {
    throw new Error('course verifier: plan receipt is missing or invalid')
  }
  return result
}

/** Persist the confirmed intake bits through the existing progress command. */
export async function writeCourseConfirmation(runtime: CourseVerifierRuntime, course: string): Promise<void> {
  if (!await accepted(runtime, course, 'convert_materials.py', [
    'progress', '--goal', 'true', '--materials', 'true', '--baseline', 'true',
  ])) throw new Error('course verifier: could not persist intake confirmation')
}

async function verifyMaterials(course: string): Promise<CourseStageEvidence | null> {
  const manifest = await json(join(course, '_工作区', '资料索引.json'))
  const sources = rows(manifest?.sources)
  if (sources === null || sources.length === 0) return null
  const checked: string[][] = []
  for (const source of sources) {
    if (typeof source.id !== 'string' || typeof source.path !== 'string' || !isAbsolute(source.path)
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(source.sha256)) return null
    if (await shaFile(source.path) !== source.sha256) return null
    checked.push([source.id, source.path, source.sha256])
  }
  return evidence(checked, `已核对 ${sources.length} 份原始资料`)
}

async function verifyTranscription(
  runtime: CourseVerifierRuntime, course: string, model: string | null,
): Promise<CourseStageEvidence | null> {
  const ledger = await json(join(course, '_工作区', '转写任务.json'))
  const sources = rows(ledger?.sources)
  if (sources === null || sources.length === 0) return null
  const vision = sources.some(source => rows(source.units)?.some(unit => unit.processing_route === 'vision') === true)
  if (vision) {
    const state = await json(join(course, '_工作区', '能力探针', 'current.json'))
    const probe = record(state?.probe) ? state.probe : null
    if (model === null || probe?.passed !== true || probe.model !== model || state?.capability_blocked === true) return null
  }
  if (!await accepted(runtime, course, 'convert_materials.py', ['check'])) return null
  const index = await shaFile(join(course, '_工作区', '转写索引.json'))
  return evidence([index, sources.map(source => [source.id, source.transcript_hash])], '来源转写及视觉探针已核验')
}

async function verifyKnowledge(runtime: CourseVerifierRuntime, course: string): Promise<CourseStageEvidence | null> {
  if (!await accepted(runtime, course, 'assemble_knowledge.py', ['--check'])) return null
  return evidence(await shaFile(join(course, '知识内容.md')), '完整知识库已核验')
}

async function verifyPath(course: string): Promise<CourseStageEvidence | null> {
  const path = await readFile(join(course, '学习路径.md'), 'utf8')
  const index = await json(join(course, '_工作区', '路径索引.json'))
  const chapterIndex = await json(join(course, '_工作区', '章节索引.json'))
  const steps = rows(index?.steps)
  const lessons = rows(chapterIndex?.lessons)
  if (!path.includes('<!-- BL-PATH:BEGIN ') || steps === null || steps.length === 0
    || lessons === null || lessons.length === 0) return null
  const assigned = new Set<string>()
  for (const step of steps) {
    if (!Array.isArray(step.lessons)) return null
    for (const lesson of step.lessons) {
      if (typeof lesson !== 'string') return null
      assigned.add(lesson)
    }
  }
  if (lessons.some(lesson => typeof lesson.id !== 'string' || !assigned.has(lesson.id))) return null
  return evidence([createHash('sha256').update(path).digest('hex'),
    steps.map(step => [step.id, step.lessons]), lessons.map(lesson => lesson.id)], '学习路径覆盖全部讲义章节')
}

async function verifyLessons(runtime: CourseVerifierRuntime, course: string): Promise<CourseStageEvidence | null> {
  if (!await accepted(runtime, course, 'lesson_tasks.py', ['check'])) return null
  const ledger = await json(join(course, '_工作区', '讲义任务.json'))
  const lessons = rows(ledger?.lessons)
  if (lessons === null || lessons.length === 0) return null
  return evidence(lessons.map(lesson => [lesson.id, lesson.semantic_hash ?? lesson.output_hash]),
    `已提交并核验 ${lessons.length} 讲`)
}

async function verifyCards(runtime: CourseVerifierRuntime, course: string): Promise<CourseStageEvidence | null> {
  if (!await accepted(runtime, course, 'core_cards.py', ['check'])) return null
  const state = await json(join(course, '_工作区', '核心卡片状态.json'))
  if (state?.status !== 'complete' || !Array.isArray(state.cards)) return null
  return evidence([state.cards, state.cards_hash], `已核验 ${state.cards.length} 张核心卡片`)
}

async function verifyDelivery(runtime: CourseVerifierRuntime, course: string): Promise<CourseStageEvidence | null> {
  if (!await accepted(runtime, course, 'validate_package.py', ['--mode', 'packaged'])) return null
  const report = await json(join(course, '_工作区', '打包检查.json'))
  const snapshot = await json(join(course, '_工作区', '链接校验报告.json'))
  if (report?.mode !== 'packaged' || report.passed !== true || !record(snapshot?.files)) return null
  return evidence([snapshot.files, report.counts, report.graph_policy_version], '课程包通过 packaged 校验')
}

/**
 * Create the production verifier. Existing Python validators remain the source of
 * truth while their invocation moves from a model shell into the Desktop Host.
 * @param runtime - Bundled Python and application-owned validation scripts.
 * @returns A verifier that returns null for absent or rejected course evidence.
 */
export function createCourseStageVerifier(runtime: CourseVerifierRuntime): CourseStageVerifier {
  if (!isAbsolute(runtime.python) || !isAbsolute(runtime.scripts)) {
    throw new Error('course verifier: bundled runtime paths must be absolute')
  }
  return async (course, stage: CourseStage, model) => {
    try {
      if (stage === 'materials') return await verifyMaterials(course)
      if (stage !== 'delivery' && await verifyMaterials(course) === null) return null
      if (stage !== 'delivery' && stage !== 'transcription'
        && await verifyTranscription(runtime, course, model) === null) return null
      if (stage === 'path' || stage === 'lessons' || stage === 'cards') {
        if (await verifyKnowledge(runtime, course) === null) return null
      }
      if (stage === 'lessons' || stage === 'cards') {
        if (await verifyPath(course) === null) return null
      }
      switch (stage) {
        case 'transcription': return await verifyTranscription(runtime, course, model)
        case 'knowledge': return await verifyKnowledge(runtime, course)
        case 'path': return await verifyPath(course)
        case 'lessons': return await verifyLessons(runtime, course)
        case 'cards': return await verifyCards(runtime, course)
        case 'delivery': return await verifyDelivery(runtime, course)
      }
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return null
      throw error
    }
  }
}
