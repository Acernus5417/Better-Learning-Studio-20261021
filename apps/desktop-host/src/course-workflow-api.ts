/** Authenticated Desktop API for application-owned course stage control. */

import { access, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-projection'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installPrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { CourseWorkflow, type CourseStage } from './course-workflow.ts'
import {
  createCourseStageVerifier, inspectCoursePlan, runCourseMaterials, runCourseScript, writeCourseConfirmation,
  type CourseVerifierRuntime,
} from './course-stage-verifier.ts'
import { CourseTranscriptionBatchService } from './course-transcription-batch.ts'
import { CourseVisionProbeService } from './course-vision-probe.ts'
import { recoverStoppedCourseAttempts } from './course-transcription-recovery.ts'
import { CourseWatchdogService, type CourseWatchdogPolicy } from './course-watchdog-service.ts'
import { importCourseAttachments, refreshCourseInventory } from './course-attachments.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'course-batch': { kind: 'course-batch'; form: 'notice'; summary: string }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const COURSE_GUIDES = {
  overview: 'runtime-policy.md',
  intake: 'references/intake.md',
  'material-processing': 'references/material-processing.md',
  'image-first': 'references/native-transcription.md',
  'worker-policy': 'references/worker-policy.md',
  'knowledge-model': 'references/knowledge-model.md',
  'knowledge-store': 'references/knowledge-store.md',
  'knowledge-chapter-template': 'assets/templates/knowledge-chapter.md',
  'learning-path': 'references/learning-path.md',
  'learning-path-template': 'assets/templates/learning-path.md',
  'chapter-writing': 'references/chapter-writing.md',
  'lesson-pipeline': 'references/lesson-pipeline.md',
  'lesson-writing-policy': 'references/lesson-writing-policy.md',
  'learning-chapter-template': 'assets/templates/learning-chapter.md',
  'core-cards': 'references/core-cards.md',
  'obsidian-links': 'references/obsidian-links.md',
  'core-card-template': 'assets/templates/core-card.md',
  'quality-checks': 'references/quality-checks.md',
  'delivery-layout': 'references/delivery-layout.md',
} as const
type CourseGuide = keyof typeof COURSE_GUIDES

const COURSE_STEPS = {
  'knowledge-assemble': { stages: ['knowledge'], script: 'assemble_knowledge.py', args: [] },
  'knowledge-check': { stages: ['knowledge', 'path', 'lessons', 'cards'], script: 'assemble_knowledge.py', args: ['--check'] },
  'lesson-prepare': { stages: ['lessons'], script: 'lesson_tasks.py', args: ['prepare'] },
  'lesson-commit': { stages: ['lessons'], script: 'lesson_tasks.py', args: ['commit'] },
  'lesson-status': { stages: ['lessons'], script: 'lesson_tasks.py', args: ['status'] },
  'lesson-check': { stages: ['lessons'], script: 'lesson_tasks.py', args: ['check'] },
  'cards-prepare': { stages: ['cards'], script: 'core_cards.py', args: ['prepare'] },
  'cards-lint': { stages: ['cards'], script: 'core_cards.py', args: ['lint'] },
  'cards-finalize': { stages: ['cards'], script: 'core_cards.py', args: ['finalize'] },
  'links-rebuild': { stages: ['cards'], script: 'obsidian_links.py', args: ['rebuild'] },
  'cards-check': { stages: ['cards'], script: 'core_cards.py', args: ['check'] },
  'final-check': { stages: ['delivery'], script: 'validate_package.py', args: ['--mode', 'final'] },
  'package-preview': { stages: ['delivery'], script: 'convert_materials.py', args: ['package', '--dry-run'] },
  package: { stages: ['delivery'], script: 'convert_materials.py', args: ['package'] },
} as const satisfies Record<string, {
  stages: readonly CourseStage[]
  script: Parameters<typeof runCourseScript>[2]
  args: readonly string[]
}>
type CourseStep = keyof typeof COURSE_STEPS

async function readCourseGuide(
  scripts: string, section: string,
): Promise<{ section: CourseGuide; scriptsRoot: string; content: string }> {
  if (!Object.hasOwn(COURSE_GUIDES, section)) throw new Error('course workflow: unknown guide section')
  const name = section as CourseGuide
  return { section: name, scriptsRoot: scripts,
    content: await readFile(join(scripts, '..', COURSE_GUIDES[name]), 'utf8') }
}

/** Resolve only directories inside a workspace already registered by the Desktop app. */
export async function resolveRegisteredCourse(
  workspaces: readonly { readonly id: string; readonly path: string }[],
  workspaceId: string,
  relativeCourse: string,
): Promise<string> {
  const workspace = workspaces.find(item => item.id === workspaceId)
  if (workspace === undefined) throw new Error('course workflow: workspace is not registered')
  if (relativeCourse !== '.' && (relativeCourse === '' || relativeCourse === '..'
    || relativeCourse.includes('/') || relativeCourse.includes('\\'))) {
    throw new Error('course workflow: invalid relative course path')
  }
  const workspaceRoot = await realpath(workspace.path)
  const directory = await realpath(resolve(workspaceRoot, relativeCourse))
  const child = relative(workspaceRoot, directory)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('course workflow: course directory escapes workspace')
  }
  if (relativeCourse !== '.' && child.includes(sep)) {
    throw new Error('course workflow: course must be a direct workspace child')
  }
  if (!(await stat(directory)).isDirectory()) throw new Error('course workflow: course path is not a directory')
  return directory
}

/** The model tool can address only its own Session workspace or one direct child. */
export async function resolveAgentCourse(
  workspaces: readonly { readonly id: string; readonly path: string }[], cwd: string, course: string,
): Promise<string> {
  const root = await realpath(cwd)
  for (const workspace of workspaces) {
    let workspaceRoot: string
    try { workspaceRoot = await realpath(workspace.path) }
    catch { continue } // An unavailable unrelated workspace cannot block the current Session.
    const child = relative(workspaceRoot, root)
    if (child === '') return resolveRegisteredCourse(workspaces, workspace.id, course)
    if (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      && !child.includes(sep) && course === '.') {
      return resolveRegisteredCourse(workspaces, workspace.id, child)
    }
  }
  throw new Error('course workflow: session is outside a registered course workspace')
}

/** Create exactly one new direct-child course for a Session rooted at a registered workspace. */
export async function createAgentCourse(
  workspaces: readonly { readonly id: string; readonly path: string }[], cwd: string, name: string,
): Promise<string> {
  if (name.trim() !== name || name.length < 1 || name.length > 80 || name.endsWith('.')
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) || name === '_工作区') {
    throw new Error('course workflow: invalid new course name')
  }
  const sessionRoot = await realpath(cwd)
  const workspace = await Promise.all(workspaces.map(async (item) => {
    try { return { ...item, root: await realpath(item.path) } }
    catch { return null }
  })).then(items => items.find(item => item?.root === sessionRoot))
  if (workspace === undefined || workspace === null) {
    throw new Error('course workflow: new courses require a registered workspace-root Session')
  }
  await mkdir(resolve(sessionRoot, name))
  return resolveRegisteredCourse(workspaces, workspace.id, name)
}

/** A model may commit intake only during a live root turn containing direct human input. */
export function requireHumanCourseConfirmation(ctx: Context, agent: Agent): number {
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent || !ctx.agents.roots().includes(agent)) {
    throw new Error('course workflow: confirmation requires the live root agent')
  }
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary?.openTurnStartSeq === null || boundary === undefined) {
    throw new Error('course workflow: confirmation requires an open human turn')
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Current Session log authority read.
  const events = agent.session.snapshotEvents()
  for (let seq = boundary.openTurnStartSeq + 1; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') return seq
  }
  throw new Error('course workflow: confirmation requires a direct human message in this turn')
}

/** Discover native cursors in the supported workspace-root or direct-child layout. */
export async function discoverSavedCourses(
  workspaces: readonly { readonly path: string }[],
): Promise<string[]> {
  const courses = new Set<string>()
  for (const workspace of workspaces) {
    const candidates = [workspace.path]
    try {
      for (const entry of await readdir(workspace.path, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== '_工作区') candidates.push(resolve(workspace.path, entry.name))
      }
    } catch (error) {
      console.error(`course workflow: cannot list workspace ${workspace.path}:`, error)
      continue
    }
    for (const candidate of candidates) {
      try {
        const course = await realpath(candidate)
        const child = relative(workspace.path, course)
        if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) continue
        await access(resolve(course, '_工作区', '内置工作流.json'))
        courses.add(course)
      } catch (error) {
        if (!record(error) || error.code !== 'ENOENT') {
          console.error(`course workflow: cannot inspect course ${candidate}:`, error)
        }
      }
    }
  }
  return [...courses]
}

/** Install the course API after the Desktop profile and Connection are ready. */
export async function installCourseWorkflowApi(
  ctx: Context, source: string, installRoot: string, scripts: string, watchdogPolicy: CourseWatchdogPolicy,
): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(installRoot) || !isAbsolute(scripts)) {
    throw new Error('course workflow: runtime paths must be absolute')
  }
  if (ctx.get('workspaceRegistry') === undefined || ctx.get('connection') === undefined
    || ctx.get('tools') === undefined || ctx.get('agents') === undefined || ctx.get('subagents') === undefined
    || ctx.get('sessionProjections') === undefined || ctx.get('attachments') === undefined) {
    throw new Error('course workflow: Workspace, Connection, Tools, Agents, Subagents, attachments, and projections are required')
  }
  let runtimePromise: Promise<CourseVerifierRuntime> | undefined
  const runtime = (): Promise<CourseVerifierRuntime> => runtimePromise ??= installPrimaryRuntime(source, installRoot)
    .then(paths => ({ python: paths.python, scripts }))
    .catch((error: unknown) => { runtimePromise = undefined; throw error })
  const workflows = new Map<string, CourseWorkflow>()
  const watchdogs = new CourseWatchdogService(ctx, watchdogPolicy)
  const workflow = (course: string): CourseWorkflow => {
    let item = workflows.get(course)
    if (item === undefined) {
      item = new CourseWorkflow(course, async (root, stage, model) =>
        createCourseStageVerifier(await runtime())(root, stage, model))
      workflows.set(course, item)
    }
    return item
  }
  const batches = new CourseTranscriptionBatchService(
    async (course, args) => runCourseMaterials(await runtime(), course, args),
    (parent, bootstrap, signal) => ctx.subagents.start('spawn', {
      parent, signal, prompt: [{ type: 'text', text: bootstrap }],
      agentOptions: parentAgentOptionsForDelegation(parent),
      toolFilter: { allow: ['read', 'read_image', 'write', 'edit'] }, maxDepth: 1,
      persona: '你是 Better Learning Studio 的独立视觉转写成员。只按任务文件和策略看图、忠实转写并写入分配的暂存文件；不教学、不猜写、不读取其他课程资料。只回短状态。',
    }),
    async (parent, course, outcomes) => {
      const unavailable = outcomes.some(item => item.outcome === 'vision_unavailable')
      if (unavailable) {
        const state = await workflow(course).inspect()
        if (state?.stage === 'transcription' && state.status === 'running') {
          await workflow(course).pause('视觉模型无法可靠读取图片；请调整模型后重新运行探针')
          await watchdogs.stop(course)
        }
      } else await watchdogs.check(course)
      if (ctx.agents.get(parent.id) !== parent) return
      const issues = outcomes.filter(item => item.outcome !== 'complete').length
      const summary = `视觉转写一批 ${outcomes.length} 个成员已结束${issues > 0 ? `，${issues} 项待检查` : ''}`
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: `${summary}。${unavailable
          ? '视觉能力未通过，课程已暂停；向学习者说明并等待调整模型。'
          : '宿主已按真实成员终态收集结果。请检查课程状态，未完成时继续调用 course_workflow transcribe-batch；资料转写全部完成后再验收当前阶段。'}` }],
        source: { kind: 'course-batch', form: 'notice', summary: boundContextSummary(summary) },
      }))
    },
  )
  const probes = new CourseVisionProbeService(
    async (course, args) => runCourseMaterials(await runtime(), course, args),
    (parent, prompt, signal) => ctx.subagents.start('spawn', {
      parent, signal, prompt: [{ type: 'text', text: prompt }],
      agentOptions: parentAgentOptionsForDelegation(parent),
      toolFilter: { allow: ['read_image', 'write'] }, maxDepth: 1,
      persona: '你是 Better Learning Studio 的独立视觉探针成员。严格按当前提示实际读图，只写指定 JSON；不读取其他文件、脚本或历史答案。只回简短状态。',
    }),
  )
  ctx.effect(() => async () => { await batches.stop() })
  for (const course of await discoverSavedCourses(ctx.workspaceRegistry.list())) {
    try { await workflow(course).reconcile() }
    catch (error) { console.error(`course workflow: recovery failed for ${course}:`, error) }
  }
  const perform = async (
    course: string, action: string, model?: string, reason?: string, summary?: string, humanSeq?: number,
    section?: string, step?: string, lesson?: string,
    parent?: Agent, signal?: AbortSignal,
  ): Promise<unknown> => {
    const cursor = workflow(course)
    if (parent !== undefined && model !== undefined && [
      'start', 'prepare-transcription', 'probe', 'transcribe-batch', 'assemble-transcription',
      'diagnose-transcription', 'run-step', 'complete-stage',
    ].includes(action)) {
      const state = await cursor.inspect()
      if (state?.model !== model) {
        throw new Error('course workflow: selected model differs from course model; pause and change-model before continuing')
      }
    }
    switch (action) {
      case 'inspect': {
        return cursor.inspect()
      }
      case 'guide': {
        const state = await cursor.inspect()
        if (section === undefined) return { stage: state?.stage ?? 'legacy', scriptsRoot: scripts,
          available: Object.keys(COURSE_GUIDES) }
        return readCourseGuide(scripts, section)
      }
      case 'refresh-inventory': {
        const state = await cursor.inspect()
        if (state?.stage !== 'materials' || !['ready', 'running'].includes(state.status)) {
          throw new Error('course workflow: inventory can be refreshed only during the materials stage')
        }
        return refreshCourseInventory(course, await runtime(), ctx.attachments)
      }
      case 'run-step': {
        const state = await cursor.inspect()
        if (state?.status !== 'running' || state.stage === 'complete'
          || step === undefined || !Object.hasOwn(COURSE_STEPS, step)) {
          throw new Error('course workflow: a known mechanical step and running stage are required')
        }
        const selected = COURSE_STEPS[step as CourseStep]
        if (!(selected.stages as readonly CourseStage[]).includes(state.stage)) {
          throw new Error(`course workflow: ${step} is not allowed during ${state.stage}`)
        }
        const args: string[] = [...selected.args]
        if (step === 'lesson-commit') {
          if (lesson === undefined || !/^L-[A-Z0-9-]{1,60}$/u.test(lesson)) {
            throw new Error('course workflow: a valid lesson ID is required')
          }
          args.push('--lesson', lesson)
        }
        return runCourseScript(await runtime(), course, selected.script, args)
      }
      case 'initialize': {
        if (await cursor.inspect() !== null) throw new Error('course workflow: this course already has a cursor')
        try {
          await access(resolve(course, '_工作区', '生成进度.json'))
          throw new Error('course workflow: a legacy course exists here; explicit migration is required')
        } catch (error) {
          if (!record(error) || error.code !== 'ENOENT') throw error
        }
        const plan = await inspectCoursePlan(await runtime(), course)
        return { plan, state: await cursor.initialize() }
      }
      case 'propose': {
        if (summary === undefined || humanSeq === undefined) throw new Error('course workflow: intake summary is required')
        return cursor.propose(summary, humanSeq)
      }
      case 'confirm':
      case 'change-model': {
        if (model === undefined) throw new Error('course workflow: model is required')
        return action === 'confirm'
          ? cursor.confirm(model, async () => writeCourseConfirmation(await runtime(), course))
          : cursor.changeModel(model)
      }
      case 'start': {
        const started = await cursor.start()
        if (started.stage === 'transcription') {
          try { await watchdogs.start(course, parent) }
          catch (error) {
            await watchdogs.stop(course)
            await cursor.pause('看门狗无法启动，请检查转写台账后重试')
            throw error
          }
        }
        return started
      }
      case 'transcribe-batch': {
        const state = await cursor.inspect()
        if (state?.stage !== 'transcription' || state.status !== 'running'
          || model === undefined || parent === undefined || signal === undefined) {
          throw new Error('course workflow: a running transcription stage and root agent are required')
        }
        const result = await batches.start(course, model, parent, signal)
        if (result.blocked !== null && result.started.length === 0 && !result.batchOpen) {
          await cursor.pause(`转写派发受阻：${result.blocked}`)
          await watchdogs.stop(course)
        }
        return result
      }
      case 'prepare-transcription':
      case 'assemble-transcription':
      case 'diagnose-transcription': {
        const state = await cursor.inspect()
        if (state?.stage !== 'transcription' || state.status !== 'running') {
          throw new Error('course workflow: a running transcription stage is required')
        }
        const command = action === 'prepare-transcription' ? 'prepare'
          : action === 'assemble-transcription' ? 'assemble' : 'diagnose'
        return runCourseMaterials(await runtime(), course, [command])
      }
      case 'probe': {
        const state = await cursor.inspect()
        if (state?.stage !== 'transcription' || state.status !== 'running'
          || model === undefined || parent === undefined || signal === undefined) {
          throw new Error('course workflow: a running transcription stage and root agent are required')
        }
        try { return await probes.run(course, model, parent, signal) }
        catch (error) {
          await cursor.pause('视觉能力探针未通过；请调整多模态模型后重试')
          await watchdogs.stop(course)
          throw error
        }
      }
      case 'complete-stage': {
        const before = await cursor.inspect()
        const result = await cursor.completeStage()
        if (before?.stage === 'transcription') await watchdogs.stop(course)
        return result
      }
      case 'reconcile': {
        const reconciled = await cursor.reconcile()
        if (reconciled.state.stage === 'transcription' && reconciled.state.status !== 'running') {
          await watchdogs.stop(course)
        }
        return reconciled
      }
      case 'resume': {
        const state = await cursor.inspect()
        if (state?.status !== 'paused' && state?.status !== 'needs_review') {
          throw new Error('course workflow: course is not paused')
        }
        if (state.stage === 'transcription') {
          await recoverStoppedCourseAttempts(course, new Set(ctx.agents.list().map(agent => agent.id)),
            batches.hasActive(course), async (root, args) => runCourseMaterials(await runtime(), root, args))
        }
        return cursor.resume()
      }
      case 'watchdog': return watchdogs.check(course)
      case 'pause': {
        if (reason === undefined || reason.trim() === '') throw new Error('course workflow: reason is required')
        const result = await cursor.pause(reason)
        await batches.stopCourse(course)
        await watchdogs.stop(course)
        return result
      }
      default: throw new Error('course workflow: unknown action')
    }
  }
  ctx.connection.fetch.register({
    path: '/api/better-learning/workflow', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await request.text()
        if (body.length > 16_384) return new Response('request too large', { status: 413 })
        const input: unknown = JSON.parse(body)
        if (!record(input) || typeof input.workspaceId !== 'string' || typeof input.course !== 'string'
          || typeof input.action !== 'string') return new Response('invalid request', { status: 400 })
        const course = await resolveRegisteredCourse(ctx.workspaceRegistry.list(), input.workspaceId, input.course)
        if (!['inspect', 'initialize', 'confirm', 'change-model', 'start', 'complete-stage', 'pause', 'reconcile', 'resume', 'watchdog']
          .includes(input.action)) return new Response('unknown action', { status: 400 })
        if ((input.action === 'confirm' || input.action === 'change-model') && typeof input.model !== 'string') {
          return new Response('model is required', { status: 400 })
        }
        if (input.action === 'pause' && (typeof input.reason !== 'string' || input.reason.trim() === '')) {
          return new Response('reason is required', { status: 400 })
        }
        const result = await perform(course, input.action,
          typeof input.model === 'string' ? input.model : undefined,
          typeof input.reason === 'string' ? input.reason : undefined)
        return Response.json(result)
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 })
      }
    },
  })
  ctx.tools.register(defineTool({
    name: 'course_workflow',
    description: 'Inspect or advance the application-owned Better Learning course workflow. create-course imports attachments from its direct human turn. import-attachments adds files from the current direct human turn during the materials stage; refresh-inventory retries inventory of already saved sources after an interruption. Use guide overview and stage-specific sections instead of loading a skill. Save a proposed intake summary and confirm only in a later direct human turn. During transcription, prepare-transcription creates the unit ledger, probe verifies the current model with a fresh image-reading child, transcribe-batch runs one whole isolated child batch, and assemble-transcription merges completed sources. run-step executes whitelisted mechanical commands only in their matching stage. Complete each stage only after saved artifacts pass validation.',
    parameters: {
      action: { type: 'string', required: true,
        enum: ['inspect', 'guide', 'create-course', 'initialize', 'import-attachments', 'refresh-inventory', 'propose', 'confirm', 'change-model', 'start', 'prepare-transcription', 'probe', 'transcribe-batch', 'assemble-transcription', 'diagnose-transcription', 'run-step', 'complete-stage', 'pause', 'reconcile', 'resume', 'watchdog'] },
      course: { type: 'string', description: 'Current Session course directory (.) or one direct child of its registered workspace. For create-course, a new direct-child name.' },
      section: { type: 'string', description: 'For guide: overview or a named stage reference/template. Omit to list available sections.',
        enum: Object.keys(COURSE_GUIDES) },
      step: { type: 'string', description: 'For run-step: a whitelisted mechanical command from the application workflow.',
        enum: Object.keys(COURSE_STEPS) },
      lesson: { type: 'string', description: 'Required for run-step lesson-commit: the L-* lesson ID.' },
      summary: { type: 'string', description: 'Required for propose: the learner-facing summary of goal, complete material scope, and baseline.' },
      reason: { type: 'string', description: 'Required reason when pausing a running stage.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        result: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    timeoutMs: 330_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) {
        throw new Error('course workflow: a live root agent is required')
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new Error('course workflow: session has no course workspace')
      if (args.action === 'create-course') {
        const humanSeq = requireHumanCourseConfirmation(ctx, agent)
        if (args.course === undefined) throw new Error('course workflow: new course name is required')
        const created = await createAgentCourse(ctx.workspaceRegistry.list(), cwd, args.course)
        const initialization = await perform(created, 'initialize')
        // oxlint-disable-next-line typescript/no-deprecated -- Current Session log authority read.
        const message = agent.session.snapshotEvents()[humanSeq]
        try {
          const imported = message?.type === 'user/message'
            ? await importCourseAttachments(created, message.data.content, ctx.attachments, await runtime(), cwd) : null
          return { result: JSON.stringify({ course: args.course, initialization, imported }) }
        } catch (error) {
          // Course creation has already committed. Return its identity so a
          // retry cannot accidentally create a second course.
          return { result: JSON.stringify({
            course: args.course, initialization, importError: error instanceof Error ? error.message : String(error),
            recovery: 'Use import-attachments in this human turn, or refresh-inventory if the source ledger was saved.',
          }) }
        }
      }
      const course = await resolveAgentCourse(ctx.workspaceRegistry.list(), cwd, args.course ?? '.')
      if (args.action === 'import-attachments') {
        const state = await workflow(course).inspect()
        if (state?.stage !== 'materials' || !['ready', 'running'].includes(state.status)) {
          throw new Error('course workflow: attachments can be imported only during the materials stage')
        }
        const humanSeq = requireHumanCourseConfirmation(ctx, agent)
        // oxlint-disable-next-line typescript/no-deprecated -- Current Session log authority read.
        const message = agent.session.snapshotEvents()[humanSeq]
        if (message?.type !== 'user/message') throw new Error('course workflow: direct human message is missing')
        const imported = await importCourseAttachments(course, message.data.content, ctx.attachments, await runtime(), cwd)
        if (imported === null) throw new Error('course workflow: the current human message has no attachments')
        return { result: JSON.stringify(imported) }
      }
      const humanSeq = args.action === 'propose' || args.action === 'confirm'
        ? requireHumanCourseConfirmation(ctx, agent) : undefined
      if (args.action === 'confirm') {
        const proposed = (await workflow(course).inspect())?.intakeProposal
        if (proposed === undefined || humanSeq === undefined || humanSeq <= proposed.humanSeq) {
          throw new Error('course workflow: wait for the learner to confirm the saved intake proposal in a later turn')
        }
      }
      const model = agent.session.requestHeader()?.config.model ?? agent.options.model
      const result = await perform(course, args.action, model, args.reason, args.summary, humanSeq,
        args.section, args.step, args.lesson, agent, exec.signal)
      return { result: JSON.stringify(result) }
    },
    presentCall: args => ({ card: 'generic', title: `Course workflow: ${args.action}`, kind: 'other' }),
  }))
}
