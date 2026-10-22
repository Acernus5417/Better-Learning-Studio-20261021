/** Shipped Studio presets must render their persona before requesting a model. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

class StudioRequestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Studio model request accepted.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('web e2e: Studio model request', { retry: 0 }, () => {
  let scaffold: WebScaffold
  const adapter = new StudioRequestAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['studio-prompt-test'], adapter))
  }, 120_000)

  afterAll(async () => { await scaffold?.close() })

  it.each(['better-learning', 'better-learning-vision', 'better-learning-probe'])(
    'sends a model request and saves its answer under %s', async (preset) => {
      const before = adapter.requests.length
      const handle = await scaffold.ctx.agents.create({
        sessionId: SessionId(`studio-prompt-${preset}`),
        meta: { cwd: scaffold.workspaceCwd, agentPreset: preset },
        agentOptions: { provider: 'studio-prompt-test', model: 'studio-model' },
        setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
      })
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Reply briefly without using tools.' }], source: { kind: 'user' },
        }))
        await handle.agent.whenIdle()
        const requests = adapter.requests.slice(before)
        expect(requests).toHaveLength(1)
        const request = requests[0]!
        const system = request.messages.filter(message => message.role === 'system')
          .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        const user = request.messages.filter(message => message.role === 'user')
          .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        expect(system).not.toContain('{{cwd}}')
        expect(user).toContain(`Current working directory: ${JSON.stringify(scaffold.workspaceCwd)}.`)
        if (preset === 'better-learning') expect(system).toContain('当前模型是 studio-model。')
        const events = handle.agent.session.snapshotEvents()
        expect(events.some(event => event.type === 'assistant/message'
          && JSON.stringify(event.data).includes('Studio model request accepted.'))).toBe(true)
        expect(events.filter(event => event.type === 'system/message')
          .some(event => JSON.stringify(event.data).includes('{{cwd}}'))).toBe(false)
      } finally {
        await handle.dispose()
      }
    },
  )
})
