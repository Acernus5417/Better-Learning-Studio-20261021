/** Durable, application-owned stage control for one Better Learning Studio course. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** Stages whose outputs must be checked before the next stage starts. */
export const COURSE_STAGES = [
  'materials', 'transcription', 'knowledge', 'path', 'lessons', 'cards', 'delivery',
] as const
export type CourseStage = typeof COURSE_STAGES[number]
export type CourseWorkflowStatus = 'waiting_confirmation' | 'ready' | 'running' | 'paused' | 'needs_review' | 'complete'

/** Proof supplied by a stage verifier after checking files and the relevant script receipt. */
export interface CourseStageEvidence {
  readonly signature: string
  readonly summary: string
}

/** Persisted application control state; course output and script ledgers remain separate. */
export interface CourseWorkflowState {
  readonly schemaVersion: 1
  readonly courseRoot: string
  readonly stage: CourseStage | 'complete'
  readonly status: CourseWorkflowStatus
  readonly confirmations: { readonly goal: boolean; readonly materials: boolean; readonly baseline: boolean }
  readonly intakeProposal?: { readonly summary: string; readonly humanSeq: number }
  readonly model: string | null
  readonly validated: Partial<Record<CourseStage, CourseStageEvidence>>
  readonly nextAction: string
  readonly updatedAt: string
}

/** A verifier reads existing course artifacts; it never accepts a model's success claim alone. */
export type CourseStageVerifier = (courseRoot: string, stage: CourseStage, model: string | null) => Promise<CourseStageEvidence | null>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStage(value: unknown): value is CourseStage {
  return typeof value === 'string' && COURSE_STAGES.some(stage => stage === value)
}

function stageAfter(stage: CourseStage): CourseStage | 'complete' {
  return COURSE_STAGES[COURSE_STAGES.indexOf(stage) + 1] ?? 'complete'
}

function evidenceBefore(
  validated: Partial<Record<CourseStage, CourseStageEvidence>>, stage: CourseStage,
): Partial<Record<CourseStage, CourseStageEvidence>> {
  const retained: Partial<Record<CourseStage, CourseStageEvidence>> = {}
  for (const earlier of COURSE_STAGES.slice(0, COURSE_STAGES.indexOf(stage))) {
    const proof = validated[earlier]
    if (proof !== undefined) retained[earlier] = proof
  }
  return retained
}

function nextAction(stage: CourseStage | 'complete'): string {
  return stage === 'complete' ? '课程已通过打包校验' : `待执行 ${stage} 阶段`
}

function parseState(value: unknown, courseRoot: string): CourseWorkflowState {
  if (!record(value) || value.schemaVersion !== 1 || value.courseRoot !== courseRoot
    || !(isStage(value.stage) || value.stage === 'complete')
    || !['waiting_confirmation', 'ready', 'running', 'paused', 'needs_review', 'complete'].includes(String(value.status))
    || !record(value.confirmations) || !record(value.validated)
    || typeof value.nextAction !== 'string' || typeof value.updatedAt !== 'string'
    || !(value.model === null || typeof value.model === 'string')) {
    throw new Error('course workflow: invalid or unsupported saved state')
  }
  const confirmations = value.confirmations
  if (typeof confirmations.goal !== 'boolean' || typeof confirmations.materials !== 'boolean'
    || typeof confirmations.baseline !== 'boolean') throw new Error('course workflow: invalid confirmations')
  const proposal = value.intakeProposal
  if (proposal !== undefined && (!record(proposal) || typeof proposal.summary !== 'string'
    || proposal.summary.trim() === '' || !Number.isSafeInteger(proposal.humanSeq)
    || (proposal.humanSeq as number) < 0)) {
    throw new Error('course workflow: invalid intake proposal')
  }
  const validated: Partial<Record<CourseStage, CourseStageEvidence>> = {}
  for (const [stage, evidence] of Object.entries(value.validated)) {
    if (!isStage(stage) || !record(evidence) || typeof evidence.signature !== 'string'
      || evidence.signature.length === 0 || typeof evidence.summary !== 'string') {
      throw new Error('course workflow: invalid stage evidence')
    }
    validated[stage] = { signature: evidence.signature, summary: evidence.summary }
  }
  const status = value.status
  if (status !== 'waiting_confirmation' && status !== 'ready' && status !== 'running'
    && status !== 'paused' && status !== 'needs_review' && status !== 'complete') {
    throw new Error('course workflow: invalid status')
  }
  if ((value.stage === 'complete') !== (status === 'complete')) {
    throw new Error('course workflow: invalid completed stage')
  }
  if (status !== 'waiting_confirmation' && (value.model === null
    || !confirmations.goal || !confirmations.materials || !confirmations.baseline)) {
    throw new Error('course workflow: invalid confirmed intake')
  }
  const completed = value.stage === 'complete' ? COURSE_STAGES
    : COURSE_STAGES.slice(0, COURSE_STAGES.indexOf(value.stage))
  if (completed.some(stage => validated[stage] === undefined)
    || Object.keys(validated).some(stage => !completed.some(done => done === stage))) {
    throw new Error('course workflow: invalid validated stages')
  }
  return {
    schemaVersion: 1, courseRoot, stage: value.stage, status,
    confirmations: { goal: confirmations.goal, materials: confirmations.materials, baseline: confirmations.baseline },
    ...proposal === undefined ? {} : { intakeProposal: { summary: proposal.summary as string, humanSeq: proposal.humanSeq as number } },
    model: value.model, validated, nextAction: value.nextAction, updatedAt: value.updatedAt,
  }
}

/**
 * Own the stage cursor and recheck saved evidence before resuming an interrupted course.
 * @param courseRoot - One absolute course directory; no parent-directory discovery is performed.
 * @param verify - Host adapter that checks the stage's actual output and receipt.
 * @param now - Clock used for persisted timestamps.
 */
export class CourseWorkflow {
  readonly courseRoot: string
  private readonly file: string
  private pending: Promise<unknown> = Promise.resolve()

  constructor(courseRoot: string, private readonly verify: CourseStageVerifier, private readonly now = () => new Date()) {
    if (!isAbsolute(courseRoot)) throw new Error('course workflow: course directory must be absolute')
    this.courseRoot = resolve(courseRoot)
    this.file = join(this.courseRoot, '_工作区', '内置工作流.json')
  }

  private async read(): Promise<CourseWorkflowState | null> {
    let source: string
    try { source = await readFile(this.file, 'utf8') }
    catch (error) {
      if (record(error) && error.code === 'ENOENT') return null
      throw error
    }
    const value: unknown = JSON.parse(source)
    return parseState(value, this.courseRoot)
  }

  private async write(state: CourseWorkflowState): Promise<CourseWorkflowState> {
    const directory = join(this.courseRoot, '_工作区')
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.内置工作流-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
    return state
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  /** Read the persisted cursor without creating course files. */
  inspect(): Promise<CourseWorkflowState | null> { return this.locked(() => this.read()) }

  /** Create a new course cursor, leaving the intake confirmation to the chat. */
  initialize(): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      if (await this.read() !== null) throw new Error('course workflow: this course already has a cursor')
      return this.write({
        schemaVersion: 1, courseRoot: this.courseRoot, stage: 'materials', status: 'waiting_confirmation',
        confirmations: { goal: false, materials: false, baseline: false }, model: null, validated: {},
        nextAction: '确认学习目标、资料范围和基础', updatedAt: this.now().toISOString(),
      })
    })
  }

  /** Save the learner-facing intake summary before asking them to confirm or amend it. */
  propose(summary: string, humanSeq: number): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'waiting_confirmation') throw new Error('course workflow: intake is not awaiting confirmation')
      if (summary.trim() === '' || !Number.isSafeInteger(humanSeq) || humanSeq < 0) {
        throw new Error('course workflow: invalid intake proposal')
      }
      return this.write({ ...state, intakeProposal: { summary: summary.trim(), humanSeq },
        nextAction: '等待学习者确认或修改学习目标、资料范围和基础', updatedAt: this.now().toISOString() })
    })
  }

  /** New human-admitted sources require a fresh intake summary and confirmation. */
  reopenIntake(): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.stage !== 'materials') throw new Error('course workflow: intake can reopen only during materials')
      const { intakeProposal: _proposal, ...withoutProposal } = state
      return this.write({ ...withoutProposal, status: 'waiting_confirmation', model: null,
        confirmations: { goal: false, materials: false, baseline: false },
        nextAction: '资料范围已更新，请重新归纳学习目标、资料范围和基础并等待确认',
        updatedAt: this.now().toISOString() })
    })
  }

  /** Record one intake confirmation after updating the legacy progress receipt. */
  confirm(model: string, updateProgress: () => Promise<void> = () => Promise.resolve()): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'waiting_confirmation') throw new Error('course workflow: intake is not awaiting confirmation')
      if (model.trim() === '') throw new Error('course workflow: model is required')
      await updateProgress()
      return this.write({ ...state, confirmations: { goal: true, materials: true, baseline: true },
        model, status: 'ready', nextAction: nextAction(state.stage), updatedAt: this.now().toISOString() })
    })
  }

  /** Begin the next stage after the previous validator admitted it. */
  start(): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'ready' || state.stage === 'complete') throw new Error('course workflow: stage is not ready')
      return this.write({ ...state, status: 'running', nextAction: `正在执行 ${state.stage} 阶段`,
        updatedAt: this.now().toISOString() })
    })
  }

  /** Advance only when the Host verifier finds the actual stage receipt. */
  completeStage(): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'running' || state.stage === 'complete') throw new Error('course workflow: no running stage')
      const evidence = await this.verify(this.courseRoot, state.stage, state.model)
      if (evidence === null || evidence.signature === '') throw new Error(`course workflow: ${state.stage} did not pass validation`)
      const stage = stageAfter(state.stage)
      return this.write({ ...state, stage, status: stage === 'complete' ? 'complete' : 'ready',
        validated: { ...state.validated, [state.stage]: evidence }, nextAction: nextAction(stage),
        updatedAt: this.now().toISOString() })
    })
  }

  /** Pause a running stage without claiming its partial output is valid. */
  pause(reason: string): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'running') throw new Error('course workflow: no running stage to pause')
      return this.write({ ...state, status: 'paused', nextAction: reason,
        updatedAt: this.now().toISOString() })
    })
  }

  /**
   * Recheck saved gates after an interruption; a running stage becomes reviewable, never silently resumes.
   * @returns Reconciled state and the earliest stage whose receipt changed.
   */
  reconcile(): Promise<{ state: CourseWorkflowState; invalidated: CourseStage | null }> {
    return this.locked(async () => {
      const state = await this.requireState()
      // Each gate checks its upstream dependencies. Rechecking only the most recent
      // gate avoids treating later link rendering and packaging as an old-stage edit.
      const previous = state.stage === 'complete' ? 'delivery'
        : COURSE_STAGES[COURSE_STAGES.indexOf(state.stage) - 1]
      const completed = previous === undefined || (state.stage === 'delivery' && state.status === 'running')
        ? [] : [previous]
      for (const stage of completed) {
        let current: CourseStageEvidence | null
        try { current = await this.verify(this.courseRoot, stage, state.model) }
        catch (error) {
          const retryStage = state.stage === 'complete' ? 'delivery' : state.stage
          const validated = state.stage === 'complete' ? evidenceBefore(state.validated, 'delivery') : state.validated
          const message = error instanceof Error ? error.message : String(error)
          const changed = await this.write({ ...state, stage: retryStage, status: 'needs_review', validated,
            nextAction: `${stage} 阶段恢复校验暂不可用：${message.slice(0, 240)}；检查运行环境后重试`,
            updatedAt: this.now().toISOString() })
          return { state: changed, invalidated: null }
        }
        if (current?.signature !== state.validated[stage]?.signature) {
          const validated = evidenceBefore(state.validated, stage)
          const changed = await this.write({ ...state, stage, status: 'needs_review', validated,
            nextAction: `${stage} 阶段校验已失效，请确认后重试`, updatedAt: this.now().toISOString() })
          return { state: changed, invalidated: stage }
        }
      }
      if (state.status !== 'running') return { state, invalidated: null }
      const changed = await this.write({ ...state, status: 'needs_review',
        nextAction: `${state.stage} 阶段中断，检查任务状态后继续`, updatedAt: this.now().toISOString() })
      return { state: changed, invalidated: null }
    })
  }

  /** Continue only by an explicit action after reconciliation and any needed user review. */
  resume(): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (state.status !== 'paused' && state.status !== 'needs_review') {
        throw new Error('course workflow: course is not paused')
      }
      return this.write({ ...state, status: 'ready', nextAction: nextAction(state.stage),
        updatedAt: this.now().toISOString() })
    })
  }

  /** A changed model invalidates the visual probe and all dependent writing. */
  changeModel(model: string): Promise<CourseWorkflowState> {
    return this.locked(async () => {
      const state = await this.requireState()
      if (model.trim() === '') throw new Error('course workflow: model is required')
      if (state.model === model) return state
      if (state.status === 'waiting_confirmation') throw new Error('course workflow: confirm intake before selecting a new model')
      if (state.status === 'running') throw new Error('course workflow: pause active work before changing model')
      const validated = evidenceBefore(state.validated, 'transcription')
      const stage = state.validated.materials === undefined ? 'materials' : 'transcription'
      return this.write({ ...state, model, stage, status: 'needs_review', validated,
        nextAction: stage === 'transcription' ? '模型已变更，重新运行真实图片探针后继续' : nextAction(stage),
        updatedAt: this.now().toISOString() })
    })
  }

  private async requireState(): Promise<CourseWorkflowState> {
    const state = await this.read()
    if (state === null) throw new Error('course workflow: course is not initialized')
    return state
  }
}
