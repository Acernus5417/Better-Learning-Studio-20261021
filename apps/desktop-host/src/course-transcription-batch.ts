/** Host-owned one-batch visual transcription dispatch and collection. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface MaterialsCommand {
  (course: string, args: readonly string[]): Promise<Record<string, unknown>>
}

export interface BatchChildStarter {
  (parent: Agent, bootstrap: string, signal: AbortSignal): Promise<SubagentActivation>
}

export interface CourseBatchResult {
  readonly batchNo: number
  readonly batchOpen: boolean
  readonly started: readonly { readonly attempt: string; readonly childId: string }[]
  readonly failedToStart: readonly string[]
  readonly blocked: string | null
}

interface Ticket { readonly attempt: string; readonly bootstrap: string }
interface Settlement { readonly attempt: string; readonly outcome: string }
interface ActiveBatch {
  readonly controllers: Set<AbortController>
  readonly startupDone: Promise<void>
  readonly finishStartup: () => void
  settlements: Promise<Settlement>[]
  done?: Promise<void>
  cancelled?: boolean
}

function tickets(value: unknown): Ticket[] {
  if (!Array.isArray(value)) throw new Error('course transcription: invalid pump tickets')
  const parsed: Ticket[] = []
  for (const raw of value) {
    const item: unknown = raw
    if (!record(item) || typeof item.attempt !== 'string' || typeof item.bootstrap !== 'string') {
      throw new Error('course transcription: invalid pump tickets')
    }
    parsed.push({ attempt: item.attempt, bootstrap: item.bootstrap })
  }
  if (parsed.length > 8) throw new Error('course transcription: batch exceeds eight members')
  return parsed
}

/** Exactly one batch per course; each child owns only its attempt's staging files. */
export class CourseTranscriptionBatchService {
  private readonly active = new Map<string, ActiveBatch>()

  hasActive(course: string): boolean { return this.active.has(course) }

  constructor(
    private readonly command: MaterialsCommand,
    private readonly startChild: BatchChildStarter,
    private readonly notify: (parent: Agent, course: string, outcomes: readonly Settlement[]) => void | Promise<void>,
  ) {}

  /** Reserve a whole batch, start fresh visual children, then return while the Host collects them. */
  async start(course: string, model: string, parent: Agent, signal: AbortSignal): Promise<CourseBatchResult> {
    if (this.active.has(course)) throw new Error('course transcription: a batch is already running')
    const startup = Promise.withResolvers<undefined>()
    const batch: ActiveBatch = { controllers: new Set(), startupDone: startup.promise,
      finishStartup: () => { startup.resolve(undefined) }, settlements: [] }
    this.active.set(course, batch)
    try {
      signal.throwIfAborted()
      const pumped = await this.command(course, ['pump', '--host', 'dsh', '--model', model])
      const batchNo = pumped.batch_no
      if (!Number.isSafeInteger(batchNo) || (batchNo as number) < 0 || typeof pumped.batch_open !== 'boolean') {
        throw new Error('course transcription: invalid pump result')
      }
      const reserved = tickets(pumped.tickets)
      const blocked = typeof pumped.blocked === 'string' ? pumped.blocked : null
      if (pumped.batch_open || reserved.length === 0) {
        this.active.delete(course)
        return { batchNo: batchNo as number, batchOpen: pumped.batch_open, started: [], failedToStart: [], blocked }
      }
      const started: { attempt: string; childId: string }[] = []
      const failedToStart: string[] = []
      await Promise.all(reserved.map(async (ticket) => {
        if (batch.cancelled) {
          try { await this.command(course, ['fail-attempt', '--attempt', ticket.attempt, '--kind', 'SPAWN_FAILURE']) }
          catch (error) { console.error('course transcription: could not release cancelled reservation:', error) }
          failedToStart.push(`${ticket.attempt}: batch stopped before member creation`)
          return
        }
        const controller = new AbortController()
        batch.controllers.add(controller)
        const abortStartup = (): void => { controller.abort(signal.reason) }
        signal.addEventListener('abort', abortStartup, { once: true })
        let run: SubagentActivation
        try { run = await this.startChild(parent, ticket.bootstrap, controller.signal) }
        catch (error) {
          batch.controllers.delete(controller)
          try {
            await this.command(course, ['fail-attempt', '--attempt', ticket.attempt, '--kind', 'SPAWN_FAILURE'])
          } catch (releaseError) {
            console.error('course transcription: could not release unstarted attempt:', releaseError)
          }
          failedToStart.push(`${ticket.attempt}: ${error instanceof Error ? error.message : String(error)}`)
          return
        } finally { signal.removeEventListener('abort', abortStartup) }
        if (Boolean(batch.cancelled)) controller.abort()
        try {
          await this.command(course, ['mark-running', '--attempt', ticket.attempt, '--agent-id', run.childId])
        } catch (error) {
          controller.abort(error)
          try { await run.dispose() }
          catch (disposeError) { console.error('course transcription: child disposal failed:', disposeError) }
          batch.controllers.delete(controller)
          failedToStart.push(`${ticket.attempt}: member started but could not be registered; inspect the reserved attempt`)
          return
        }
        started.push({ attempt: ticket.attempt, childId: run.childId })
        batch.settlements.push(this.settle(course, ticket.attempt, run, controller))
      }))
      if (batch.settlements.length === 0) {
        this.active.delete(course)
      } else {
        batch.done = Promise.all(batch.settlements).then(async (outcomes) => {
          if (!batch.cancelled) await this.notify(parent, course, outcomes)
        })
          .catch((error: unknown) => { console.error('course transcription: completion notification failed:', error) })
          .finally(() => { if (this.active.get(course) === batch) this.active.delete(course) })
      }
      return { batchNo: batchNo as number, batchOpen: false, started, failedToStart, blocked }
    } catch (error) {
      batch.cancelled = true
      for (const controller of batch.controllers) controller.abort(error)
      await Promise.allSettled(batch.settlements)
      if (this.active.get(course) === batch) this.active.delete(course)
      throw error
    } finally { batch.finishStartup() }
  }

  private async settle(
    course: string, attempt: string, run: SubagentActivation, controller: AbortController,
  ): Promise<Settlement> {
    try {
      const result = await run.result
      await run.dispose()
      if (result.stopReason === 'completed') {
        const collected = await this.command(course, ['collect', '--attempt', attempt, '--stopped-agent-id', run.childId])
        return { attempt, outcome: collected.capability_blocked === true ? 'vision_unavailable'
          : collected.state === 'committed' ? 'complete' : 'needs_review' }
      }
      await this.command(course, ['fail-attempt', '--attempt', attempt, '--kind', 'TEMP_TOOL_FAILURE',
        '--stopped-agent-id', run.childId])
      return { attempt, outcome: result.stopReason }
    } catch (error) {
      try { await run.dispose() }
      catch (disposeError) { console.error('course transcription: child disposal failed:', disposeError) }
      console.error(`course transcription: attempt ${attempt} needs review:`, error)
      return { attempt, outcome: 'needs_review' }
    } finally { controller.abort(); this.active.get(course)?.controllers.delete(controller) }
  }

  /** Stop one course's batch without queueing a completion follow-up. */
  async stopCourse(course: string): Promise<void> {
    const batch = this.active.get(course)
    if (batch === undefined) return
    batch.cancelled = true
    for (const controller of batch.controllers) controller.abort()
    await batch.startupDone
    for (const controller of batch.controllers) controller.abort()
    await batch.done?.catch(() => undefined)
    if (this.active.get(course) === batch) this.active.delete(course)
  }

  /** Abort owned children and wait for their Host-side settlement on shutdown. */
  async stop(): Promise<void> {
    await Promise.all([...this.active.keys()].map(course => this.stopCourse(course)))
  }
}
