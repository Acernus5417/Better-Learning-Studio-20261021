// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CourseNotePicker } from '../src/client/course/Notes.tsx'
import { organizeCourseNotes } from '@deepseek-ai/dsh-util-course-document'
import type { CourseInjected } from '../src/client/course/Workbench.tsx'
import { zh } from '../src/client/course/locales.ts'
import type {} from '../src/client/course/apply.ts'

afterEach(cleanup)
const replies = [
  { id: 'reply-1' as MessageId, text: '先理解复数的几何意义。', time: 1 },
  { id: 'reply-2' as MessageId, text: '复数乘法对应旋转与缩放。', time: 2 },
]
const t: TranslateNS<'course'> = (key) => zh[key as keyof typeof zh]
function fixture() {
  const request = vi.fn().mockResolvedValue({ path: '笔记/01-复数-笔记.md' })
  const saved = vi.fn(),
    close = vi.fn()
  render(
    <CourseNotePicker
      target={{ id: 'course-a', path: '学习文档/01-复数.md', sessionId: 'study-a' }}
      replies={replies}
      initial="reply-2"
      request={request as CourseInjected['request']}
      saved={saved}
      close={close}
      t={t}
    />,
  )
  return { request, saved, close }
}
describe('document learning notes', () => {
  it('preselects the clicked answer, supports multiple selection and lets the learner edit before saving', async () => {
    const f = fixture()
    expect((screen.getByRole('radio', { name: '回答 2' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '回答 1' }))
    fireEvent.click(screen.getByRole('button', { name: '整理预览' }))
    const preview = screen.getByRole('textbox', { name: '笔记内容' })
    expect((preview as HTMLTextAreaElement).value).toBe(organizeCourseNotes(replies))
    fireEvent.change(preview, { target: { value: '我整理的笔记内容' } })
    fireEvent.click(screen.getByRole('button', { name: '写入笔记' }))
    await waitFor(() => {
      expect(f.saved).toHaveBeenCalledWith('笔记/01-复数-笔记.md')
    })
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'course-a',
        path: '学习文档/01-复数.md',
        messageIds: ['reply-2', 'reply-1'],
        text: '我整理的笔记内容',
      }),
    )
  })
  it('retains preview and operation identity after an uncertain save so a retry cannot duplicate it', async () => {
    const f = fixture()
    f.request.mockRejectedValueOnce(new Error('Lost response'))
    fireEvent.click(screen.getByRole('button', { name: '整理预览' }))
    fireEvent.click(screen.getByRole('button', { name: '写入笔记' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('textbox', { name: '笔记内容' }) as HTMLTextAreaElement).value).toContain(replies[1]!.text)
    fireEvent.click(screen.getByRole('button', { name: '写入笔记' }))
    await waitFor(() => {
      expect(f.saved).toHaveBeenCalledOnce()
    })
    expect(f.request.mock.calls[0]?.[0].operationId).toBe(f.request.mock.calls[1]?.[0].operationId)
  })
})
