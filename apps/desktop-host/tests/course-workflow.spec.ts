import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COURSE_STAGES, CourseWorkflow, type CourseStage, type CourseStageEvidence } from '../src/course-workflow.ts'

const roots: string[] = []
async function course(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bls-native-course-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('native course workflow cursor', () => {
  it('persists an intake proposal for the learner to confirm or amend', async () => {
    const root = await course()
    const workflow = new CourseWorkflow(root, async () => null)
    await workflow.initialize()
    await expect(workflow.propose(' ', 2)).rejects.toThrow('invalid intake proposal')
    expect(await workflow.propose('  目标：理解图示；资料：三份；基础：初学  ', 2))
      .toMatchObject({ status: 'waiting_confirmation', intakeProposal: {
        summary: '目标：理解图示；资料：三份；基础：初学', humanSeq: 2,
      } })
    const restarted = new CourseWorkflow(root, async () => null)
    expect((await restarted.inspect())?.intakeProposal?.humanSeq).toBe(2)
  })

  it('admits stages only after a real verifier result and completes at delivery', async () => {
    const root = await course()
    const receipts = new Map<CourseStage, CourseStageEvidence>()
    const workflow = new CourseWorkflow(root, async (_root, stage) => receipts.get(stage) ?? null)
    expect((await workflow.initialize()).status).toBe('waiting_confirmation')
    await expect(workflow.start()).rejects.toThrow('not ready')
    expect((await workflow.confirm('multimodal-model')).confirmations).toEqual({ goal: true, materials: true, baseline: true })
    for (const stage of COURSE_STAGES) {
      expect((await workflow.start()).stage).toBe(stage)
      await expect(workflow.completeStage()).rejects.toThrow('did not pass validation')
      receipts.set(stage, { signature: `${stage}-receipt`, summary: `${stage} checked` })
      const result = await workflow.completeStage()
      expect(result.validated[stage]?.signature).toBe(`${stage}-receipt`)
    }
    const saved = await workflow.inspect()
    expect(saved).toMatchObject({ stage: 'complete', status: 'complete' })
    expect(JSON.parse(await readFile(join(root, '_工作区', '内置工作流.json'), 'utf8'))).toEqual(saved)
    await expect(workflow.start()).rejects.toThrow('not ready')
  })

  it('marks an interrupted stage for review and resumes only on explicit action', async () => {
    const root = await course()
    const receipts = new Map<CourseStage, CourseStageEvidence>([
      ['materials', { signature: 'material-hash', summary: 'source inventory checked' }],
    ])
    const verify = async (_root: string, stage: CourseStage) => receipts.get(stage) ?? null
    const first = new CourseWorkflow(root, verify)
    await first.initialize()
    await first.confirm('multimodal-model')
    await first.start()
    await first.completeStage()
    await first.start()

    const restarted = new CourseWorkflow(root, verify)
    expect(await restarted.reconcile()).toMatchObject({ state: { stage: 'transcription', status: 'needs_review' }, invalidated: null })
    await expect(restarted.start()).rejects.toThrow('not ready')
    expect((await restarted.resume()).status).toBe('ready')
  })

  it('returns to the earliest changed gate and preserves earlier evidence', async () => {
    const root = await course()
    const receipts = new Map<CourseStage, CourseStageEvidence>([
      ['materials', { signature: 'first', summary: 'checked' }],
      ['transcription', { signature: 'transcribed', summary: 'checked' }],
    ])
    const workflow = new CourseWorkflow(root, async (_root, stage) => receipts.get(stage) ?? null)
    await workflow.initialize()
    await workflow.confirm('multimodal-model')
    for (let index = 0; index < 2; index += 1) {
      await workflow.start()
      await workflow.completeStage()
    }
    receipts.set('transcription', { signature: 'changed', summary: 'changed input' })
    expect(await new CourseWorkflow(root, async (_root, stage) => receipts.get(stage) ?? null).reconcile())
      .toMatchObject({ state: { stage: 'transcription', status: 'needs_review', validated: { materials: { signature: 'first' } } },
        invalidated: 'transcription' })
    expect((await workflow.inspect())?.validated.transcription).toBeUndefined()
  })

  it('checks the packaged receipt rather than files deliberately removed by packaging', async () => {
    const root = await course()
    const receipts = new Map<CourseStage, CourseStageEvidence>()
    for (const stage of COURSE_STAGES) receipts.set(stage, { signature: stage, summary: 'checked' })
    const workflow = new CourseWorkflow(root, async (_root, stage) => receipts.get(stage) ?? null)
    await workflow.initialize()
    await workflow.confirm('multimodal-model')
    for (const _stage of COURSE_STAGES) { await workflow.start(); await workflow.completeStage() }
    receipts.clear()
    receipts.set('delivery', { signature: 'delivery', summary: 'packaged receipt passed' })
    expect((await new CourseWorkflow(root, async (_root, stage) => receipts.get(stage) ?? null).reconcile()).state.status)
      .toBe('complete')
  })

  it('holds a changed model at the vision stage and rejects a switch during active work', async () => {
    const root = await course()
    const workflow = new CourseWorkflow(root, async (_root, stage) => stage === 'materials'
      ? { signature: 'materials', summary: 'inventory checked' } : null)
    await workflow.initialize()
    await workflow.confirm('old-model')
    await workflow.start()
    await expect(workflow.changeModel('new-model')).rejects.toThrow('pause active work')
    await workflow.completeStage()
    const changed = await workflow.changeModel('new-model')
    expect(changed).toMatchObject({ stage: 'transcription', status: 'needs_review', model: 'new-model' })
    expect(changed.validated.materials?.signature).toBe('materials')
  })

  it('rejects malformed saved state instead of restarting at intake', async () => {
    const root = await course()
    const workflow = new CourseWorkflow(root, async () => null)
    await workflow.initialize()
    await writeFile(join(root, '_工作区', '内置工作流.json'), '{"schemaVersion":9}', 'utf8')
    await expect(workflow.inspect()).rejects.toThrow('invalid or unsupported saved state')
  })

  it('does not advance intake when the progress receipt cannot be written', async () => {
    const root = await course()
    const workflow = new CourseWorkflow(root, async () => null)
    await workflow.initialize()
    await expect(workflow.confirm('model', async () => { throw new Error('progress write failed') }))
      .rejects.toThrow('progress write failed')
    expect(await workflow.inspect()).toMatchObject({ status: 'waiting_confirmation', model: null })
  })

  it('rejects a saved completion claim without prior stage evidence', async () => {
    const root = await course()
    const workflow = new CourseWorkflow(root, async () => null)
    const state = await workflow.initialize()
    await writeFile(join(root, '_工作区', '内置工作流.json'), JSON.stringify({
      ...state, stage: 'complete', status: 'complete', model: 'model',
      confirmations: { goal: true, materials: true, baseline: true },
    }))
    await expect(workflow.inspect()).rejects.toThrow('invalid validated stages')
  })
})
