import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { SubagentActivation, SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { loadCordisYaml, presetDefinitions } from '../../../scripts/cordis-yaml.ts'
import { installCourseVisualChildPolicy, startCourseVisualChild } from '../src/course-visual-child.ts'

const childId = 'visual-child' as SubagentActivation['childId']

describe('course visual child activation', () => {
  it('ships the original personas with exactly the intended filesystem capabilities', async () => {
    const presets = presetDefinitions(loadCordisYaml(await readFile(
      new URL('../../../packages/bundle/web-app/presets/standard.patch.yml', import.meta.url), 'utf8')))
    expect(presets.filter(preset => ['better-learning-vision', 'better-learning-probe'].includes(preset.id))
      .map(({ id, plugins }) => ({ id, plugins })))
      .toEqual([
        { id: 'better-learning-vision', plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
            prefix: '你是 Better Learning Studio 的独立视觉转写成员。只按任务文件和策略看图、忠实转写并写入分配的暂存文件；不教学、不猜写、不读取其他课程资料。只回短状态。',
          } },
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: {
            read: true, readImage: true, write: true, edit: true,
          } },
        ] },
        { id: 'better-learning-probe', plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
            prefix: '你是 Better Learning Studio 的独立视觉探针成员。严格按当前提示实际读图，只写指定 JSON；不读取其他文件、脚本或历史答案。只回简短状态。',
          } },
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: {
            read: false, readImage: true, write: true, edit: false,
          } },
        ] },
      ])
  })

  it('inherits the selected model route into a fresh restricted preset without duplicate parent delivery', async () => {
    let accepted: SubagentActivationSpec | undefined
    const ctx = { subagents: { startActivation: async (spec: SubagentActivationSpec) => {
      accepted = spec
      return { childId, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => undefined }
    } } }
    const parent = { options: { provider: 'old', model: 'old-model', maxTokens: 2048 }, session: {
      requestHeader: () => ({ config: { provider: 'selected', model: 'vision-model', reasoningEffort: 'high' } }),
    } }
    const controller = new AbortController()
    const run = await startCourseVisualChild(ctx as never, parent as never, 'read the assigned task',
      controller.signal, 'better-learning-vision')
    expect(accepted).toEqual({
      provider: 'spawn', label: 'Course visual transcription', signal: controller.signal, delivery: 'caller',
      request: {
        parent, prompt: [{ type: 'text', text: 'read the assigned task' }], agentPreset: 'better-learning-vision',
        agentOptions: { provider: 'selected', model: 'vision-model', reasoningEffort: 'high', maxTokens: 2048 },
        maxDepth: 1,
      },
    })
    expect(run.childId).toBe(childId)
    expect((await run.result).stopReason).toBe('completed')
    await run.dispose()
  })

  it('cancels a published activation through exact disposal and waits for cleanup', async () => {
    const terminal = Promise.withResolvers<SubagentResult>()
    const cleanup = Promise.withResolvers<undefined>()
    let disposals = 0
    const activation: SubagentActivation = {
      childId, result: terminal.promise,
      async dispose() {
        disposals += 1
        await cleanup.promise
        terminal.resolve({ output: [], stopReason: 'aborted' })
      },
    }
    const ctx = { subagents: { startActivation: async () => activation } }
    const parent = { options: {}, session: { requestHeader: () => undefined } }
    const controller = new AbortController()
    const run = await startCourseVisualChild(ctx as never, parent as never, 'probe image',
      controller.signal, 'better-learning-probe')
    controller.abort()
    expect(disposals).toBe(1)
    const disposed = run.dispose()
    cleanup.resolve(undefined)
    await disposed
    expect((await run.result).stopReason).toBe('aborted')
    expect(disposals).toBe(1)
  })

  it('disposes a child published after its caller was cancelled', async () => {
    const publication = Promise.withResolvers<SubagentActivation>()
    const terminal = Promise.withResolvers<SubagentResult>()
    let disposals = 0
    const ctx = { subagents: { startActivation: () => publication.promise } }
    const parent = { options: {}, session: { requestHeader: () => undefined } }
    const controller = new AbortController()
    const starting = startCourseVisualChild(ctx as never, parent as never, 'probe image',
      controller.signal, 'better-learning-probe')
    controller.abort()
    publication.resolve({ childId, result: terminal.promise, async dispose() {
      disposals += 1
      terminal.resolve({ output: [], stopReason: 'aborted' })
    } })
    const run = await starting
    await run.result
    await run.dispose()
    expect(disposals).toBe(1)
  })

  it('keeps capture and disposal failures independently observable without a derived rejected result', async () => {
    const terminal = Promise.withResolvers<SubagentResult>()
    const captureError = new Error('capture unavailable')
    const cleanupError = new Error('cleanup unavailable')
    const ctx = { subagents: { startActivation: async () => ({
      childId, result: terminal.promise, dispose: async () => { throw cleanupError },
    }) } }
    const parent = { options: {}, session: { requestHeader: () => undefined } }
    const run = await startCourseVisualChild(ctx as never, parent as never, 'probe image',
      new AbortController().signal, 'better-learning-probe')
    expect(run.result).toBe(terminal.promise)
    terminal.reject(captureError)
    await expect(run.dispose()).rejects.toBe(cleanupError)
    await expect(run.result).rejects.toBe(captureError)
  })

  it('retains each visual preset filesystem allowlist without restricting the root agent', () => {
    let created: ((payload: { agent: object }) => void) | undefined
    const ctx = { on: (_name: string, handler: typeof created) => { created = handler } }
    installCourseVisualChildPolicy(ctx as never)
    const restrictions: unknown[] = []
    for (const preset of ['better-learning', 'better-learning-vision', 'better-learning-probe']) {
      created!({ agent: { session: { header: { agentPreset: preset } }, ctx: {
        tools: { restrict: (filter: unknown) => { restrictions.push({ preset, filter }) } },
      } } })
    }
    expect(restrictions).toEqual([
      { preset: 'better-learning-vision', filter: { allow: ['read', 'read_image', 'write', 'edit'] } },
      { preset: 'better-learning-probe', filter: { allow: ['read_image', 'write'] } },
    ])
  })
})
