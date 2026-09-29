/** Host-owned transcription health checks driven by child settlement events and a bounded timer. */

/** One attempt's durable ledger identity and observed Host state. */
export interface CourseAttemptHealth {
  readonly attemptId: string
  readonly childId: string | null
  readonly hostState: 'running' | 'stopped' | 'unknown'
  readonly lastActivityAt: number
}

/** The inspector combines the script ledger with actual subagent state. */
export interface CourseWatchdogInput {
  readonly active: readonly CourseAttemptHealth[]
  readonly readyUnits: number
}

/** Metadata shown as one overall course exception, without transcript content. */
export interface CourseWatchdogStatus {
  readonly checkedAt: number
  readonly activeCount: number
  readonly readyUnits: number
  readonly silentAttemptIds: readonly string[]
  readonly stoppedAttemptIds: readonly string[]
  readonly unknownAttemptIds: readonly string[]
}

/**
 * Observe transcription health without failing attempts or releasing script leases.
 * The course controller owns both the actual member-status inspector and any recovery action.
 */
export class CourseWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined
  private pending: Promise<CourseWatchdogStatus> | undefined

  constructor(
    private readonly inspect: () => Promise<CourseWatchdogInput>,
    private readonly publish: (status: CourseWatchdogStatus) => void | Promise<void>,
    private readonly intervalMs: number,
    private readonly silentMs: number,
    private readonly now = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1
      || !Number.isSafeInteger(silentMs) || silentMs < 1) throw new Error('course watchdog: invalid interval')
  }

  /** Start monitoring when the first transcription batch is dispatched. */
  start(): Promise<CourseWatchdogStatus> {
    if (this.timer !== undefined) return this.check()
    this.timer = setInterval(() => {
      void this.check().catch((error: unknown) => { console.error('course watchdog:', error) })
    }, this.intervalMs)
    return this.check()
  }

  /** A child settlement triggers an immediate check instead of waiting for the next timer tick. */
  memberSettled(): Promise<CourseWatchdogStatus> { return this.check() }

  /** A timer expiry is a reason to inspect, never proof that a child stopped. */
  check(): Promise<CourseWatchdogStatus> {
    if (this.pending !== undefined) return this.pending
    const operation = (async () => {
      const input = await this.inspect()
      const checkedAt = this.now()
      const status: CourseWatchdogStatus = {
        checkedAt, activeCount: input.active.length, readyUnits: input.readyUnits,
        silentAttemptIds: input.active.filter(attempt => attempt.hostState === 'running'
          && checkedAt - attempt.lastActivityAt > this.silentMs).map(attempt => attempt.attemptId),
        stoppedAttemptIds: input.active.filter(attempt => attempt.hostState === 'stopped')
          .map(attempt => attempt.attemptId),
        unknownAttemptIds: input.active.filter(attempt => attempt.hostState === 'unknown')
          .map(attempt => attempt.attemptId),
      }
      await this.publish(status)
      return status
    })()
    this.pending = operation
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined }).catch(() => undefined)
    return operation
  }

  /** Stop the timer after the final batch is collected or when the Host shuts down. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.pending?.catch(() => undefined)
  }
}
