/** Managed fresh children for course transcription and vision checks. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation, type SubagentActivation } from '@deepseek-ai/dsh-subagent'

/** The independently composed tool sets used by application-owned visual work. */
export type CourseVisualPreset = 'better-learning-vision' | 'better-learning-probe'

/**
 * Retain only each visual preset's filesystem tools and exclude inherited Host tools.
 * @param ctx - Desktop Host context owning the creation listener.
 */
export function installCourseVisualChildPolicy(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    const preset = agent.session.header.agentPreset
    if (preset === 'better-learning-vision') {
      agent.ctx.tools.restrict({ allow: ['read', 'read_image', 'write', 'edit'] })
    } else if (preset === 'better-learning-probe') {
      agent.ctx.tools.restrict({ allow: ['read_image', 'write'] })
    }
  })
}

/**
 * Start a fresh same-model child and retain cancellation ownership after activation publication.
 * @param ctx - Desktop Host context with the managed subagent service.
 * @param parent - Exact live root Agent delegating this work.
 * @param prompt - Only the task bootstrap or generated probe instructions.
 * @param signal - Cancels admission and disposes the accepted activation after publication.
 * @param agentPreset - Application-owned persona and filesystem tool composition.
 * @returns Exact child identity, settled result, and idempotent disposal.
 */
export async function startCourseVisualChild(
  ctx: Context, parent: Agent, prompt: string, signal: AbortSignal, agentPreset: CourseVisualPreset,
): Promise<SubagentActivation> {
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn',
    label: agentPreset === 'better-learning-probe' ? 'Course vision probe' : 'Course visual transcription',
    request: {
      parent, prompt: [{ type: 'text', text: prompt }], agentPreset,
      agentOptions: parentAgentOptionsForDelegation(parent), maxDepth: 1,
    },
    signal,
    delivery: 'caller',
  })
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    signal.removeEventListener('abort', abort)
    return disposal ??= activation.dispose()
  }
  const abort = (): void => {
    void dispose().catch((error: unknown) => { console.error('course visual child: cancellation cleanup failed:', error) })
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const settled = (): void => { signal.removeEventListener('abort', abort) }
  void activation.result.then(settled, settled)
  return {
    childId: activation.childId,
    ...(activation.messageId === undefined ? {} : { messageId: activation.messageId }),
    result: activation.result,
    dispose,
  }
}
