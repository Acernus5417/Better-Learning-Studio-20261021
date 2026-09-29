// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CourseProgress } from '../src/client/CourseProgress.tsx'
import { createCourseProgressReader } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'

const sessionId = 'course-progress-session' as SessionId
const root = 'C:/Courses'
const t = makeTranslate(zh)

describe('course progress strip', () => {
  it('shows the last durable stage, completed work, and blockers', async () => {
    const readCourseProgress = vi.fn(async () => ({
      kind: 'ready' as const,
      value: { stage: 'working', completedChapters: 2, completedLessons: 5, blockers: 1, nextAction: '待确认：继续校验' },
    }))
    render(<CourseProgress sessionId={sessionId} root={root} readCourseProgress={readCourseProgress} t={t} />)
    await waitFor(() => { expect(screen.getByText('课程未完成')).toBeTruthy() })
    expect(screen.getByText('已完成 2 章')).toBeTruthy()
    expect(screen.getByText('已完成 5 节')).toBeTruthy()
    expect(screen.getByText('1 项异常待处理')).toBeTruthy()
    expect(screen.getByText('待确认：继续校验')).toBeTruthy()
    expect(readCourseProgress).toHaveBeenCalledWith(sessionId, root, expect.any(AbortSignal))
  })

  it('keeps an unreadable checkpoint visible as an error', async () => {
    render(<CourseProgress sessionId={sessionId} root={root} readCourseProgress={async () => ({ kind: 'failed' })} t={t} />)
    await waitFor(() => { expect(screen.getByText('课程进度读取失败')).toBeTruthy() })
  })

  it('finds the only child course and honors its packaged validation receipt', async () => {
    const read = vi.fn(async (_session: SessionId, path: string) => {
      if (path === '课程甲/_工作区/生成进度.json') return { ok: true, value: { eof: true, text: JSON.stringify({ stage: 'working', blockers: [], next_action: '过期提示' }) } }
      if (path === '课程甲/_工作区/打包检查.json') return { ok: true, value: { eof: true, text: JSON.stringify({ mode: 'packaged', passed: true }) } }
      return { ok: false, error: { code: 'workspace-file/not-found' } }
    })
    const list = vi.fn(async () => ({ ok: true, value: { truncated: false, entries: [{ name: '课程甲', type: 'directory' }] } }))
    const reader = createCourseProgressReader({ workspaceFiles: { read, list } } as unknown as ClientRemote)
    expect(await reader(sessionId, root, new AbortController().signal)).toEqual({
      kind: 'ready', value: { stage: 'complete', completedChapters: 0, completedLessons: 0, blockers: 0, nextAction: undefined },
    })
    expect(list).toHaveBeenCalledWith(sessionId, root, expect.any(AbortSignal))
  })

  it('does not guess between two child courses', async () => {
    const read = vi.fn(async (_session: SessionId, path: string) => path.includes('课程')
      ? { ok: true, value: { eof: true, text: JSON.stringify({ stage: 'working' }) } }
      : { ok: false, error: { code: 'workspace-file/not-found' } })
    const list = vi.fn(async () => ({ ok: true, value: { truncated: false, entries: [
      { name: '课程甲', type: 'directory' }, { name: '课程乙', type: 'directory' },
    ] } }))
    const reader = createCourseProgressReader({ workspaceFiles: { read, list } } as unknown as ClientRemote)
    expect(await reader(sessionId, root, new AbortController().signal)).toEqual({ kind: 'multiple' })
  })

  it('shows native recovery status without reading generated content', async () => {
    const read = vi.fn(async (_session: SessionId, path: string) => {
      if (path === '_工作区/内置工作流.json') return { ok: true, value: { eof: true, text: JSON.stringify({
        schemaVersion: 1, stage: 'transcription', status: 'needs_review', nextAction: '检查中断的转写批次',
      }) } }
      if (path === '_工作区/生成进度.json') return { ok: true, value: { eof: true, text: JSON.stringify({
        stage: 'working', completed_lessons: ['L-1'], blockers: [],
      }) } }
      return { ok: false, error: { code: 'workspace-file/not-found' } }
    })
    const reader = createCourseProgressReader({ workspaceFiles: { read, list: vi.fn() } } as unknown as ClientRemote)
    expect(await reader(sessionId, root, new AbortController().signal)).toEqual({
      kind: 'ready', value: { stage: 'needs_review', completedChapters: 0, completedLessons: 1,
        blockers: 0, nextAction: '检查中断的转写批次' },
    })
  })

  it('counts Host watchdog exceptions while transcription is running', async () => {
    const read = vi.fn(async (_session: SessionId, path: string) => {
      if (path === '_工作区/内置工作流.json') return { ok: true, value: { eof: true, text: JSON.stringify({
        schemaVersion: 1, stage: 'transcription', status: 'running', nextAction: '正在转写',
      }) } }
      if (path === '_工作区/内置看门狗.json') return { ok: true, value: { eof: true, text: JSON.stringify({
        silentAttemptIds: ['A-1'], stoppedAttemptIds: ['A-2'], unknownAttemptIds: [],
      }) } }
      return { ok: false, error: { code: 'workspace-file/not-found' } }
    })
    const reader = createCourseProgressReader({ workspaceFiles: { read, list: vi.fn() } } as unknown as ClientRemote)
    expect(await reader(sessionId, root, new AbortController().signal)).toEqual({
      kind: 'ready', value: { stage: 'working', completedChapters: 0, completedLessons: 0,
        blockers: 2, nextAction: '正在转写' },
    })
  })
})
