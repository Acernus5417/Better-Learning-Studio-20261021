// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { CourseDocumentView } from '../src/client/course/DocumentView.tsx'
import { parseCourseDocument } from '@deepseek-ai/dsh-util-course-document'
import type { CourseFileContent } from '@deepseek-ai/dsh-util-course-document'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/course/apply.ts'
import { zh } from '../src/client/course/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('adopts same-source reading metadata without constructing an editor or discarding a later draft', () => {
  const initial = document('initial', 'same')
  const props = {
    id: 'course',
    file: initial,
    files: [],
    t,
    useResource,
    open: () => {},
    select: () => {},
    dirty: vi.fn<(value: boolean) => void>(),
    reload: () => {},
    save: async () => initial,
  }
  const page = render(<CourseDocumentView {...props} mode="read" />)
  expect(page.container.querySelector('.cm-editor')).toBeNull()
  const decorated: CourseFileContent = {
    ...initial,
    reading: {
      schemaVersion: 1,
      annotations: [
        {
          start: 0,
          annotation: {
            id: 'a1',
            block: 'b1',
            quote: 'initial',
            role: 'definition',
            emphasis: 'bold',
            evidence: 'same source',
          },
        },
      ],
    },
  }
  page.rerender(<CourseDocumentView {...props} file={decorated} mode="read" />)
  expect(page.container.querySelector('strong')?.textContent).toBe('initial')
  page.rerender(<CourseDocumentView {...props} file={decorated} mode="source" />)
  const element = page.container.querySelector<HTMLElement>('.cm-editor')
  if (element === null) throw new Error('Editor did not mount')
  const editor = EditorView.findFromDOM(element)
  if (editor === null) throw new Error('Editor is unavailable')
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved draft' } })
  })
  page.rerender(
    <CourseDocumentView
      {...props}
      file={{ ...initial, reading: { schemaVersion: 1, annotations: [] } }}
      mode="source"
    />,
  )
  expect(editor.state.doc.toString()).toBe('unsaved draft')
  expect(screen.getByText('有未保存修改')).toBeDefined()
})
const t: TranslateNS<'course'> = key => (key in zh ? zh[key as keyof typeof zh] : key)
const useResource: PropsRuntime<'main'>['useResource'] = () => ({
  status: 'none',
  value: undefined,
  failure: undefined,
})
const document = (text: string, version: string): CourseFileContent => ({
  path: '笔记/笔记.md',
  text,
  version,
  document: parseCourseDocument(text),
})

it('retains edits made while a previous save is in flight and keeps navigation protection active', async () => {
  const initial = document('initial', 'before')
  let finish: ((value: CourseFileContent) => void) | undefined
  const save = vi.fn(
    () =>
      new Promise<CourseFileContent>((resolve) => {
        finish = resolve
      }),
  )
  const dirty = vi.fn<(value: boolean) => void>()
  const page = render(
    <CourseDocumentView
      id="course"
      file={initial}
      files={[]}
      mode="source"
      t={t}
      useResource={useResource}
      open={() => {}}
      select={() => {}}
      dirty={dirty}
      reload={() => {}}
      save={save}
    />,
  )
  const element = page.container.querySelector<HTMLElement>('.cm-editor')
  if (element === null) throw new Error('Editor did not mount')
  const editor = EditorView.findFromDOM(element)
  if (editor === null) throw new Error('Editor instance is unavailable')
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'first draft' } })
  })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(save).toHaveBeenCalledWith('first draft', 'before')
  act(() => {
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' plus later text' } })
  })
  await act(async () => {
    finish?.(document('first draft', 'after'))
    await Promise.resolve()
  })
  await waitFor(() => {
    expect(screen.getByText('有未保存修改')).toBeTruthy()
  })
  expect(editor.state.doc.toString()).toBe('first draft plus later text')
  expect(dirty).toHaveBeenLastCalledWith(true)
})
