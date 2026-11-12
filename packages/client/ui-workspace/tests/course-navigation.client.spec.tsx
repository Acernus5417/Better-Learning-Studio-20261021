// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCourseViewStore } from '../src/client/course/store.ts'
import { CourseOutline } from '../src/client/course/Outline.tsx'
import { parseCourseDocument } from '@deepseek-ai/dsh-util-course-document'

afterEach(cleanup)
describe('course reading navigation', () => {
  it('clears destinations when course identity changes, including after starting generation', () => {
    const store = createCourseViewStore().create()
    store.actions.patch({ selectedId: 'first', path: '一.md' })
    store.actions.navigate({ path: '二.md', anchor: '@20' })
    store.actions.patch({ selectedId: 'second' })
    expect(store.getSnapshot()).toMatchObject({ path: '', anchor: '', history: [], historyIndex: -1 })
    store.actions.travel(-1)
    expect(store.getSnapshot().path).toBe('')
  })
  it('returns across files and heading anchors without losing forward destinations', () => {
    const store = createCourseViewStore().create()
    store.actions.patch({ path: '学习文档/一.md' })
    store.actions.navigate({ path: '学习文档/二.md', anchor: '定义' })
    store.actions.navigate({ path: '学习文档/二.md', anchor: '@42' })
    store.actions.travel(-1)
    expect(store.getSnapshot()).toMatchObject({ path: '学习文档/二.md', anchor: '定义', historyIndex: 1 })
    store.actions.travel(-1)
    expect(store.getSnapshot()).toMatchObject({ path: '学习文档/一.md', anchor: '', historyIndex: 0 })
    store.actions.travel(1)
    expect(store.getSnapshot()).toMatchObject({ path: '学习文档/二.md', anchor: '定义' })
  })
  it('discards forward history after a new destination and ignores out-of-range travel', () => {
    const store = createCourseViewStore().create()
    store.actions.navigate({ path: '二.md', anchor: '' })
    store.actions.navigate({ path: '三.md', anchor: '' })
    store.actions.travel(-1)
    store.actions.navigate({ path: '四.md', anchor: '' })
    const revision = store.getSnapshot().revision
    store.actions.travel(1)
    expect(store.getSnapshot().path).toBe('四.md')
    expect(store.getSnapshot().revision).toBe(revision)
    expect(store.getSnapshot().history.some(item => item.path === '三.md')).toBe(false)
  })
  it('reissues repeated heading jumps without rebuilding the same document or duplicating history', () => {
    const store = createCourseViewStore().create()
    store.actions.navigate({ path: '一.md', anchor: '@20' })
    const current = store.getSnapshot()
    store.actions.navigate({ path: '一.md', anchor: '@20' })
    expect(store.getSnapshot().history).toEqual(current.history)
    expect(store.getSnapshot().revision).toBe(current.revision)
    expect(store.getSnapshot().navigationRevision).toBe(current.navigationRevision + 1)
  })
  it('keeps the document instance for same-file history and rebuilds after accepting draft discard', () => {
    const store = createCourseViewStore().create()
    store.actions.patch({ path: '一.md' })
    store.actions.navigate({ path: '一.md', anchor: '@20' })
    const revision = store.getSnapshot().revision
    store.actions.navigate({ path: '一.md', anchor: '@80' })
    store.actions.travel(-1)
    expect(store.getSnapshot().revision).toBe(revision)
    store.actions.patch({ unsaved: true })
    store.actions.navigate({ path: '一.md', anchor: '@80' })
    expect(store.getSnapshot()).toMatchObject({ revision: revision + 1, unsaved: false })
  })
  it('shows every heading in a non-collapsible hierarchy, including skipped levels', () => {
    const source = '# 第一章\n\n### 小节\n\n#### 细节\n\n## 第二节\n\n# 第二章'
    const headings = parseCourseDocument(source).headings
    const open = vi.fn()
    const view = render(<CourseOutline headings={headings} label="大纲" open={open} />)
    expect(screen.getAllByRole('button')).toHaveLength(5)
    expect(view.container.querySelectorAll('[aria-expanded]')).toHaveLength(0)
    const detail = screen.getByRole('button', { name: '细节' })
    expect(detail.closest('ul')?.parentElement?.querySelector(':scope > button')?.textContent).toBe('小节')
    fireEvent.click(detail)
    expect(open).toHaveBeenCalledWith(source.indexOf('####'))
  })
})
