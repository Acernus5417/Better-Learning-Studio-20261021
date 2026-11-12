import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { presentationBlocks } from '@deepseek-ai/dsh-util-course-document'
import {
  planCoursePresentation,
  loadCoursePresentation,
  coursePresentationPath,
  presentationGroups,
  CoursePresentationService,
  enableCoursePresentation,
  verifyCoursePresentations,
} from '../src/course-presentation.ts'

const source = '# 定义\n\n函数将输入映射到唯一输出。\n\n## 应用\n\n输入和输出构成映射关系。\n'
const controller = (): AbortController => new AbortController()
describe('logged semantic presentation processing', () => {
  it('requires independent review and records all units without rewriting Markdown', async () => {
    const blocks = presentationBlocks(source),
      calls: string[] = []
    const result = await planCoursePresentation(
      'lesson',
      source,
      async (prompt) => {
        calls.push(prompt)
        return JSON.stringify(
          calls.length === 1
            ? {
              annotations: [
                {
                  id: 'a1',
                  block: blocks[0]!.id,
                  quote: '唯一输出',
                  role: 'definition',
                  emphasis: 'bold',
                  evidence: '定义中的唯一性约束',
                },
              ],
              units: [...new Set(blocks.map(block => block.unit))].map(unit => ({
                unit,
                reason: '保留定义中的唯一性',
              })),
            }
            : {
              approved: ['a1'],
              units: [...new Set(blocks.map(block => block.unit))].map(unit => ({
                unit,
                passed: true,
                reason: '原文明确要求唯一输出',
              })),
              missing: [],
            },
        )
      },
      controller().signal,
    )
    expect(calls).toHaveLength(2)
    expect(result.annotations).toHaveLength(1)
    expect(result.decisions.every(item => item.status === 'passed')).toBe(true)
    expect(calls[1]).toContain('独立审核')
    expect(source).not.toContain('**')
  })
  it('uses basic typography after the finite invalid-output budget', async () => {
    let calls = 0
    const result = await planCoursePresentation(
      'lesson',
      source,
      async () => {
        calls++
        return 'invalid JSON'
      },
      controller().signal,
    )
    expect(calls).toBe(2)
    expect(result.annotations).toEqual([])
    expect(result.decisions.every(item => item.status === 'basic')).toBe(true)
  })
  it('does not turn cancellation into a basic success', async () => {
    const signal = controller()
    signal.abort()
    await expect(planCoursePresentation('cards', source, async () => '{}', signal.signal)).rejects.toThrow()
  })
  it('does not truncate a single oversized unit', async () => {
    const large = '# 定义\n\n' + '完整条件，'.repeat(6000)
    let called = false
    const result = await planCoursePresentation(
      'cards',
      large,
      async () => {
        called = true
        return '{}'
      },
      controller().signal,
    )
    expect(called).toBe(false)
    expect(result.decisions[0]?.status).toBe('basic')
    expect(presentationGroups(presentationBlocks(large))).toHaveLength(1)
  })
  it('publishes only after content commit, then reuses an accepted plan on repeated commits', async () => {
    const course = await mkdtemp(join(tmpdir(), 'course-presentation-'))
    let requests = 0,
      commits = 0,
      disposals = 0
    const units = [...new Set(presentationBlocks(source).map(block => block.unit))]
    const ctx = {
      subagents: {
        startActivation: async () => {
          requests++
          return {
            childId: 'job',
            result: Promise.resolve({
              stopReason: 'completed',
              output: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    requests % 2 === 1
                      ? { annotations: [], units: units.map(unit => ({ unit, reason: '普通排版足够清楚' })) }
                      : {
                        approved: [],
                        units: units.map(unit => ({ unit, passed: true, reason: '原文语义明确无需额外强调' })),
                        missing: [],
                      },
                  ),
                },
              ],
            }),
            dispose: async () => {
              disposals++
            },
          }
        },
      },
    }
    const service = new CoursePresentationService(ctx as never)
    const parent = {
      options: { model: 'fixture' },
      session: { requestHeader: () => ({ config: { model: 'fixture' } }) },
    }
    try {
      const commit = async () => {
        commits++
        await writeFile(join(course, '讲义.md'), source)
        return { state: 'done', failure_kind: null }
      }
      const publish = () =>
        service.publish(
          course,
          { path: '讲义.md', text: source, kind: 'lesson' },
          parent as never,
          controller().signal,
          commit,
        )
      expect((await publish()).presentation).toMatchObject({ basic: 0 })
      expect((await loadCoursePresentation(course, '讲义.md', source))?.annotations).toEqual([])
      await enableCoursePresentation(course)
      expect(await verifyCoursePresentations(course, ['讲义.md'])).toMatchObject({ enabled: true, basic: 0 })
      await publish()
      expect(requests).toBe(2)
      expect(commits).toBe(2)
      expect(disposals).toBe(2)
      expect(await readFile(join(course, '讲义.md'), 'utf8')).toBe(source)
      await writeFile(join(course, '讲义.md'), source + '\n正文被编辑。')
      expect(await verifyCoursePresentations(course, ['讲义.md'])).toBeNull()
    } finally {
      await rm(course, { recursive: true, force: true })
    }
  })
  it('preserves independently accepted cards and repairs only the failed subset', async () => {
    const text =
      '<!-- BL-KP:BEGIN KP-01 -->\n\n## 第一张\n\n第一张定义。\n\n<!-- BL-KP:END KP-01 -->\n\n<!-- BL-KP:BEGIN KP-02 -->\n\n## 第二张\n\n第二张定义。\n\n<!-- BL-KP:END KP-02 -->\n'
    let calls = 0
    const result = await planCoursePresentation(
      'cards',
      text,
      async (prompt) => {
        calls++
        if (calls >= 3) expect(prompt).not.toContain('第一张定义。')
        if (calls === 1)
          return JSON.stringify({
            annotations: [],
            units: ['KP-01', 'KP-02'].map(unit => ({ unit, reason: '普通排版无需额外高亮' })),
          })
        if (calls === 2)
          return JSON.stringify({
            approved: [],
            missing: [],
            units: [
              { unit: 'KP-01', passed: true, reason: '本卡原文清楚无需强调' },
              { unit: 'KP-02', passed: false, reason: '本卡缺少重点判断依据' },
            ],
          })
        return 'invalid'
      },
      controller().signal,
    )
    expect(calls).toBe(3)
    expect(result.decisions.map(item => [item.unit, item.status])).toEqual([
      ['KP-01', 'passed'],
      ['KP-02', 'basic'],
    ])
  })
  it('never follows a foreign portable metadata symlink', async () => {
    const course = await mkdtemp(join(tmpdir(), 'course-presentation-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'course-presentation-outside-'))
    try {
      await mkdir(join(course, '.betterlearning'))
      await symlink(
        outside,
        join(course, '.betterlearning', 'presentation'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await expect(coursePresentationPath(course, '讲义.md', true)).rejects.toThrow('owned')
    } finally {
      await rm(course, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
