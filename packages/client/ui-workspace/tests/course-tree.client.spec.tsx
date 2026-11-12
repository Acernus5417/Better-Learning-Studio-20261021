// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CourseFile } from '@deepseek-ai/dsh-util-course-document'
import { buildCourseTree, CourseFileTree, visibleCourseEntry } from '../src/client/course/FileTree.tsx'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const files: CourseFile[] = [
  { path: '课程首页.md', directory: false, bytes: 1 },
  { path: '讲义/2026/10/10.md', directory: false, bytes: 1 },
  { path: '讲义/2026/10/2.md', directory: false, bytes: 1 },
  { path: '附件', directory: true, bytes: 0 },
]
function fixture(initial: readonly string[] = []) {
  const open = vi.fn(),
    context = vi.fn()
  function View() {
    const [closed, setClosed] = useState(initial)
    return (
      <CourseFileTree
        files={files}
        selected="课程首页.md"
        closed={closed}
        label="Files"
        open={open}
        context={context}
        toggle={(path) => {
          setClosed((value) => (value.includes(path) ? value.filter((item) => item !== path) : [...value, path]))
        }}
      />
    )
  }
  render(<View />)
  return { open, context }
}
describe('course file explorer', () => {
  it('keeps workflow storage and retired starter rows out of the reading directory', () => {
    expect(
      ['_工作区/x.md', '讲义/a.md', '附件/x.pdf', '课程首页.md'].filter((path) => visibleCourseEntry(path)),
    ).toEqual([])
    expect(visibleCourseEntry('讲义/任意层级/intro.md', true)).toBe(true)
    expect(['学习文档/01.md', '笔记/01-笔记.md', '课程文档/简介.md'].every((path) => visibleCourseEntry(path))).toBe(
      true,
    )
  })
  it('keeps folder focus distinct from the selected document', () => {
    fixture()
    const folder = screen.getByRole('button', { name: '讲义' })
    fireEvent.focus(folder)
    fireEvent.click(folder)
    expect(folder.dataset.selected).toBe('false')
    expect(screen.getByRole('button', { name: '课程首页.md' }).dataset.selected).toBe('true')
  })
  it('builds implicit parents and sorts folders before naturally ordered files', () => {
    const roots = buildCourseTree(files)
    expect(roots.at(-1)?.path).toBe('课程首页.md')
    const month = roots.find((row) => row.path === '讲义')?.children[0]?.children[0]
    expect(month?.path).toBe('讲义/2026/10')
    expect(month?.children.map((row) => row.name)).toEqual(['2.md', '10.md'])
  })
  it('opens files, hides extensions visually and preserves their accessible file name', () => {
    const f = fixture()
    const button = screen.getByRole('button', { name: '2.md' })
    expect(button.textContent).toBe('2')
    fireEvent.click(button)
    expect(f.open).toHaveBeenCalledWith('讲义/2026/10/2.md')
  })
  it('collapses an entire branch and reopens it without losing child structure', () => {
    fixture()
    fireEvent.click(screen.getByRole('button', { name: '讲义' }))
    expect(screen.queryByRole('button', { name: '2.md' })).toBeNull()
    expect(screen.getByRole('treeitem', { name: '讲义' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '讲义' }))
    expect(screen.getByRole('button', { name: '2.md' })).toBeTruthy()
  })
  it('uses arrow keys to open folders and move through visible rows only', () => {
    fixture(['讲义'])
    const parent = screen.getByRole('button', { name: '讲义' })
    parent.focus()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '2026' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.queryByRole('button', { name: '10' })).toBeNull()
  })
  it('offers the same file menu from pointer and keyboard', () => {
    const f = fixture()
    const file = screen.getByRole('button', { name: '课程首页.md' })
    fireEvent.contextMenu(file)
    fireEvent.keyDown(file, { key: 'F10', shiftKey: true })
    expect(f.context).toHaveBeenCalledTimes(2)
    expect(f.context.mock.lastCall?.[0]).toBe('课程首页.md')
  })
})
