/** Authenticated Desktop API for application-owned course stage control. */

import { access, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import { installPrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { CourseWorkflow } from './course-workflow.ts'
import { createCourseStageVerifier, inspectCoursePlan, writeCourseConfirmation, type CourseVerifierRuntime } from './course-stage-verifier.ts'
import { CourseWatchdogService, type CourseWatchdogPolicy } from './course-watchdog-service.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const directory = await realpath(resolve(workspace.path, relativeCourse))
  const child = relative(workspace.path, directory)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('course workflow: course directory escapes workspace')
  }
  if (!(await stat(directory)).isDirectory()) throw new Error('course workflow: course path is not a directory')
  return directory
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
  if (ctx.get('workspaceRegistry') === undefined || ctx.get('connection') === undefined) {
    throw new Error('course workflow: Workspace and Connection services are required')
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
  for (const course of await discoverSavedCourses(ctx.workspaceRegistry.list())) {
    try { await workflow(course).reconcile() }
    catch (error) { console.error(`course workflow: recovery failed for ${course}:`, error) }
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
        const cursor = workflow(course)
        let result: unknown
        switch (input.action) {
          case 'inspect': {
            const current = await cursor.inspect()
            result = current === null ? null : (await cursor.reconcile()).state
            if (record(result) && result.stage === 'transcription' && result.status !== 'running') {
              await watchdogs.stop(course)
            }
            break
          }
          case 'initialize': {
            if (await cursor.inspect() !== null) throw new Error('course workflow: this course already has a cursor')
            const plan = await inspectCoursePlan(await runtime(), course)
            result = { plan, state: await cursor.initialize() }
            break
          }
          case 'confirm':
          case 'change-model': {
            if (typeof input.model !== 'string') return new Response('model is required', { status: 400 })
            result = input.action === 'confirm'
              ? await cursor.confirm(input.model, async () => writeCourseConfirmation(await runtime(), course))
              : await cursor.changeModel(input.model)
            break
          }
          case 'start': {
            const started = await cursor.start()
            if (started.stage === 'transcription') {
              try { await watchdogs.start(course) }
              catch (error) {
                await watchdogs.stop(course)
                await cursor.pause('看门狗无法启动，请检查转写台账后重试')
                throw error
              }
            }
            result = started
            break
          }
          case 'complete-stage': {
            const before = await cursor.inspect()
            result = await cursor.completeStage()
            if (before?.stage === 'transcription') await watchdogs.stop(course)
            break
          }
          case 'reconcile': {
            const reconciled = await cursor.reconcile()
            if (reconciled.state.stage === 'transcription' && reconciled.state.status !== 'running') {
              await watchdogs.stop(course)
            }
            result = reconciled
            break
          }
          case 'resume': result = await cursor.resume(); break
          case 'watchdog': result = await watchdogs.check(course); break
          case 'pause': {
            if (typeof input.reason !== 'string' || input.reason.trim() === '') {
              return new Response('reason is required', { status: 400 })
            }
            result = await cursor.pause(input.reason)
            await watchdogs.stop(course)
            break
          }
          default: return new Response('unknown action', { status: 400 })
        }
        return Response.json(result)
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 })
      }
    },
  })
}
