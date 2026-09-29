import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  createAgentCourse, discoverSavedCourses, installCourseWorkflowApi, requireHumanCourseConfirmation, resolveAgentCourse,
  resolveRegisteredCourse,
} from '../src/course-workflow-api.ts'
import { CourseWorkflow } from '../src/course-workflow.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('course API directory selection', () => {
  it('accepts an existing course inside a registered workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    await mkdir(join(root, 'Course'))
    expect(await resolveRegisteredCourse([{ id: 'workspace-1', path: root }], 'workspace-1', 'Course'))
      .toBe(join(root, 'Course'))
  })

  it('refuses parent traversal, unknown workspaces, and files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    const workspaces = [{ id: 'workspace-1', path: root }]
    await writeFile(join(root, 'notes.md'), 'content')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', '../outside')).rejects.toThrow('invalid relative')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', 'nested/course')).rejects.toThrow('invalid relative')
    await expect(resolveRegisteredCourse(workspaces, 'other', '.')).rejects.toThrow('not registered')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', 'notes.md')).rejects.toThrow('not a directory')
  })

  it('finds persisted native courses at workspace root and direct children for startup recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    await mkdir(join(root, 'Course', '_工作区'), { recursive: true })
    await writeFile(join(root, '_工作区', '内置工作流.json'), '{}')
    await writeFile(join(root, 'Course', '_工作区', '内置工作流.json'), '{}')
    expect(await discoverSavedCourses([{ path: root }])).toEqual([root, join(root, 'Course')])
  })

  it('binds the model tool to its session directory and accepts only a direct child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    await mkdir(join(root, 'Course'))
    await mkdir(join(root, 'Course', 'Nested'))
    const workspaces = [{ id: 'offline', path: join(root, 'offline') }, { id: 'workspace-1', path: root }]
    expect(await resolveAgentCourse(workspaces, root, 'Course')).toBe(join(root, 'Course'))
    expect(await resolveAgentCourse(workspaces, join(root, 'Course'), '.')).toBe(join(root, 'Course'))
    await expect(resolveAgentCourse(workspaces, join(root, 'Course'), 'Nested')).rejects.toThrow('outside')
    await expect(resolveAgentCourse(workspaces, root, 'Course/Nested')).rejects.toThrow('invalid relative')
  })

  it('creates a unique direct-child course only from a registered workspace-root Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-create-'))
    roots.push(root)
    const workspaces = [{ id: 'workspace-1', path: root }]
    expect(await createAgentCourse(workspaces, root, '数学基础')).toBe(join(root, '数学基础'))
    await expect(createAgentCourse(workspaces, root, '数学基础')).rejects.toThrow()
    await expect(createAgentCourse(workspaces, root, 'CON.txt')).rejects.toThrow('invalid new course')
    await expect(createAgentCourse(workspaces, root, '../escape')).rejects.toThrow('invalid new course')
    await expect(createAgentCourse(workspaces, join(root, '数学基础'), 'nested')).rejects.toThrow('workspace-root')
  })

  it('keeps an active stage running when the desktop merely inspects progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    let handler: ((request: Request) => Promise<Response>) | undefined
    let courseTool: ToolDefinition | undefined
    const workspaceRegistry = { list: () => [{ id: 'workspace-1', path: root }] }
    const connection = { fetch: { register: (route: { fetch: (request: Request) => Promise<Response> }) => {
      handler = route.fetch
      return () => undefined
    } } }
    const events = [{ type: 'turn/start' }, { type: 'user/message', data: { source: { kind: 'user' } } }]
    let selectedModel = 'multimodal-model'
    const agent = { id: 'root', status: 'running', options: { model: 'multimodal-model' }, session: {
      header: { cwd: root }, requestHeader: () => ({ config: { model: selectedModel } }),
      snapshotEvents: () => events,
    } }
    const agents = { list: () => [agent], roots: () => [agent], get: () => agent, currentInitiator: () => agent }
    const subagents = { start: () => { throw new Error('unexpected visual child start') } }
    const tools = { register: (definition: ToolDefinition) => { courseTool = definition; return () => undefined } }
    const sessionProjections = { stateOf: () => ({ openTurnStartSeq: 0 }) }
    const services = { workspaceRegistry, connection, agents, subagents, tools, sessionProjections }
    const ctx = {
      ...services,
      get: (name: keyof typeof services) => services[name],
      on: () => () => undefined,
      effect: () => undefined,
    }
    await writeFile(join(root, 'runtime-policy.md'), '# Application policy\n')
    await installCourseWorkflowApi(ctx as never, root, root, join(root, 'scripts'),
      { intervalMs: 90_000, silentMs: 900_000 })
    const workflow = new CourseWorkflow(root, async () => null)
    await workflow.initialize()
    await workflow.confirm('multimodal-model')
    await workflow.start()
    const response = await handler!(new Request('http://localhost/api/better-learning/workflow', {
      method: 'POST', body: JSON.stringify({ workspaceId: 'workspace-1', course: '.', action: 'inspect' }),
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ stage: 'materials', status: 'running' })
    expect((await workflow.inspect())?.status).toBe('running')
    expect(courseTool?.name).toBe('course_workflow')
    const result = await courseTool!.execute({ action: 'inspect' }, { agent } as never)
    expect(JSON.parse((result as { result: string }).result)).toMatchObject({ status: 'running' })
    const guide = await courseTool!.execute({ action: 'guide', section: 'overview' }, { agent } as never)
    expect(JSON.parse((guide as { result: string }).result)).toEqual({
      section: 'overview', scriptsRoot: join(root, 'scripts'), content: '# Application policy\n',
    })
    await expect(courseTool!.execute({ action: 'run-step', step: 'package' }, { agent } as never))
      .rejects.toThrow('not allowed during materials')
    selectedModel = 'different-model'
    await expect(courseTool!.execute({ action: 'run-step', step: 'knowledge-check' }, { agent } as never))
      .rejects.toThrow('selected model differs')
    selectedModel = 'multimodal-model'
    await mkdir(join(root, 'New'))
    await new CourseWorkflow(join(root, 'New'), async () => null).initialize()
    const proposed = await courseTool!.execute({ action: 'propose', course: 'New', summary: '目标、资料、基础' }, { agent } as never)
    expect(JSON.parse((proposed as { result: string }).result)).toMatchObject({
      intakeProposal: { summary: '目标、资料、基础', humanSeq: 1 },
    })
    await expect(courseTool!.execute({ action: 'confirm', course: 'New' }, { agent } as never))
      .rejects.toThrow('later turn')
    await mkdir(join(root, 'Legacy', '_工作区'), { recursive: true })
    await writeFile(join(root, 'Legacy', '_工作区', '生成进度.json'), '{}')
    const legacyGuide = await courseTool!.execute({ action: 'guide', course: 'Legacy' }, { agent } as never)
    expect(JSON.parse((legacyGuide as { result: string }).result)).toMatchObject({ stage: 'legacy' })
    const legacy = await handler!(new Request('http://localhost/api/better-learning/workflow', {
      method: 'POST', body: JSON.stringify({ workspaceId: 'workspace-1', course: 'Legacy', action: 'initialize' }),
    }))
    expect(legacy.status).toBe(409)
    const rejected: unknown = await legacy.json()
    expect(JSON.stringify(rejected)).toContain('legacy course')
  })

  it('requires a direct human message in the current root turn for intake confirmation', () => {
    const events = [
      { type: 'turn/start' },
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ]
    const agent = { id: 'root', status: 'running', session: { snapshotEvents: () => events } }
    const agents = { get: () => agent, roots: () => [agent], currentInitiator: () => agent }
    const sessionProjections = { stateOf: () => ({ openTurnStartSeq: 0 }) }
    expect(() => { requireHumanCourseConfirmation({ agents, sessionProjections } as never, agent as never) })
      .not.toThrow()
    events[1] = { type: 'user/message', data: { source: { kind: 'goal' } } }
    expect(() => { requireHumanCourseConfirmation({ agents, sessionProjections } as never, agent as never) })
      .toThrow('direct human')
    events[1] = { type: 'user/message', data: { source: { kind: 'user' } } }
    expect(() => { requireHumanCourseConfirmation({
      agents: { ...agents, roots: () => [] }, sessionProjections,
    } as never, agent as never) }).toThrow('live root')
  })
})
