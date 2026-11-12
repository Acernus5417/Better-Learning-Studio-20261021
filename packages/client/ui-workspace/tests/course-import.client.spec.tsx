// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CourseImportDialog } from '../src/client/course/Import.tsx'
import { createStudioMarkdownPreference } from '../src/client/course/Presentation.tsx'
import { CourseRequestError } from '../src/client/course/resources.ts'
import type { CourseInjected } from '../src/client/course/Workbench.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/course/locales.ts'
import type {} from '../src/client/course/apply.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})
const t: TranslateNS<'course'> = key => zh[key as keyof typeof zh]
function fixture() {
  const request = vi.fn().mockResolvedValue({ id: 'imported-course', name: 'My course' })
  const imported = vi.fn(),
    close = vi.fn(),
    droppedPath = vi.fn(() => '/source/course')
  const view = render(
    <CourseImportDialog
      t={t}
      request={request as CourseInjected['request']}
      droppedPath={droppedPath}
      imported={imported}
      close={close}
    />,
  )
  return { ...view, request, imported, close, droppedPath }
}
function drop(files = [new File([], 'course')]) {
  const target = screen.getByRole('dialog').querySelector('[aria-busy]')
  if (target === null) throw new Error('Missing folder drop target')
  fireEvent.drop(target, {
    dataTransfer: { files: { length: files.length, item: (index: number) => files[index] ?? null } },
  })
}
describe('course folder import', () => {
  it('keeps only a close icon and offers no folder chooser or confirmation button', () => {
    const f = fixture()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.request).not.toHaveBeenCalled()
  })
  it('imports the dropped directory automatically without another confirmation', async () => {
    const f = fixture()
    const file = new File([], 'course')
    drop([file])
    await waitFor(() => {
      expect(f.imported).toHaveBeenCalledWith(expect.objectContaining({ id: 'imported-course' }))
    })
    expect(f.request).toHaveBeenLastCalledWith({ action: 'import', source: '/source/course' })
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.droppedPath).toHaveBeenCalledWith(file)
  })
  it('blocks duplicate drops and closing while the import is in flight', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<{ id: string }>()
    f.request.mockReturnValueOnce(pending.promise)
    drop()
    expect(screen.getByRole('status').textContent).toBe('正在处理…')
    drop()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.close).not.toHaveBeenCalled()
    pending.resolve({ id: 'imported-course' })
    await waitFor(() => {
      expect(f.imported).toHaveBeenCalledOnce()
    })
  })
  it('keeps an invalid folder unimported and permits another drop', async () => {
    const f = fixture()
    f.request.mockRejectedValueOnce(new CourseRequestError('missing md', 'IMPORT_MARKDOWN'))
    drop()
    await screen.findByText('文件夹中至少需要一个 .md 文件')
    expect(f.imported).not.toHaveBeenCalled()
    drop()
    await waitFor(() => {
      expect(f.imported).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('rejects dropping multiple folders before calling the host', () => {
    const f = fixture()
    drop([new File([], 'first'), new File([], 'second')])
    expect(screen.getByRole('alert').textContent).toBe('请一次拖入一个课程文件夹')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('reports an unavailable native path without creating a course', () => {
    const f = fixture()
    f.droppedPath.mockReturnValue('')
    drop()
    expect(screen.getByRole('alert')).toBeDefined()
    expect(f.request).not.toHaveBeenCalled()
  })
})
describe('Studio Markdown presentation preference', () => {
  it('defaults to styled reading and persists the off setting for the next app opening', () => {
    const first = createStudioMarkdownPreference()
    expect(first.source.getSnapshot()).toBe(true)
    first.set(false)
    expect(createStudioMarkdownPreference().source.getSnapshot()).toBe(false)
  })
  it('keeps the accepted setting when persistence is refused', () => {
    const first = createStudioMarkdownPreference()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(() => {
      first.set(false)
    }).toThrow('storage denied')
    expect(first.source.getSnapshot()).toBe(true)
  })
})
