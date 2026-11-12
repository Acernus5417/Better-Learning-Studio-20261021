/** Run a fresh image-reading challenge in a separate DSH child context. */

import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { MaterialsCommand } from './course-transcription-batch.ts'

/** The Host reads only the generated prompt, never the challenge image or expected hashes. */
export class CourseVisionProbeService {
  private readonly active = new Set<string>()

  constructor(
    private readonly command: MaterialsCommand,
    private readonly startChild: (parent: Agent, prompt: string, signal: AbortSignal) => Promise<SubagentActivation>,
  ) {}

  async run(course: string, model: string, parent: Agent, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.active.has(course)) throw new Error('course vision probe: already running')
    this.active.add(course)
    let run: SubagentActivation | undefined
    try {
      signal.throwIfAborted()
      const challenge = await this.command(course, ['probe-start', '--host', 'dsh', '--model', model])
      if (typeof challenge.prompt !== 'string' || challenge.prompt === '' || resolve(course, challenge.prompt) === course) {
        throw new Error('course vision probe: invalid prompt path')
      }
      const promptPath = resolve(course, challenge.prompt)
      if (!promptPath.startsWith(`${course}${sep}`) || challenge.prompt.includes('..')) {
        throw new Error('course vision probe: prompt escapes course')
      }
      const prompt = await readFile(promptPath, 'utf8')
      run = await this.startChild(parent, prompt, signal)
      const childId = run.childId
      const result = await run.result
      await run.dispose()
      run = undefined
      if (result.stopReason !== 'completed') {
        throw new Error(`course vision probe: child ended with ${result.stopReason}`)
      }
      const checked = await this.command(course, ['probe', '--member', childId,
        '--host', 'dsh', '--model', model])
      if (checked.probe !== 'passed') throw new Error('course vision probe: challenge failed')
      return checked
    } finally {
      if (run !== undefined) await run.dispose().catch(() => undefined)
      this.active.delete(course)
    }
  }
}
