// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CourseReader } from '../src/client/course/DocumentView.tsx'
import { parseCourseDocument } from '@deepseek-ai/dsh-util-course-document'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/course/locales.ts'
import type {} from '../src/client/course/apply.ts'

const observed = new Map<Element, { callback: IntersectionObserverCallback; observer: IntersectionObserver }>()
class Observer implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds = []
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element): void {
    observed.set(element, { callback: this.callback, observer: this })
  }
  unobserve(element: Element): void {
    observed.delete(element)
  }
  disconnect(): void {
    observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
const t: TranslateNS<'course'> = key => zh[key as keyof typeof zh]
const useResource: PropsRuntime<'main'>['useResource'] = () => ({
  status: 'none',
  value: undefined,
  failure: undefined,
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  observed.clear()
})
function fixture(text: string, focus?: number) {
  vi.stubGlobal('IntersectionObserver', Observer)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => {
      callback(performance.now())
    }, 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    window.clearTimeout(id)
  })
  const file = { path: 'A.md', text, version: text, document: parseCourseDocument(text) }
  const props = { id: 'course', file, files: [], t, useResource, open: vi.fn(), select: vi.fn(), focus }
  return { ...render(<CourseReader {...props} />), props }
}
it('prepares nearby formulas only, retaining later text and its source mapping', async () => {
  const source = '# Formula\n\nFirst $x^2$.\n\nLater $y^2$.'
  const view = fixture(source)
  const pending = view.container.querySelectorAll<HTMLElement>('[data-course-math-pending]')
  expect(pending.length).toBe(2)
  expect(screen.getByText('Later', { exact: false })).toBeDefined()
  const first = pending[0]!,
    item = observed.get(first)!
  const rect = first.getBoundingClientRect()
  item.callback(
    [
      {
        target: first,
        isIntersecting: true,
        boundingClientRect: rect,
        intersectionRect: rect,
        intersectionRatio: 1,
        rootBounds: null,
        time: performance.now(),
      },
    ],
    item.observer,
  )
  await waitFor(() => {
    expect(first.hasAttribute('data-course-math-pending')).toBe(false)
  })
  expect(pending[1]!.hasAttribute('data-course-math-pending')).toBe(true)
  view.rerender(<CourseReader {...view.props} focus={source.length} />)
  await waitFor(() => {
    expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(0)
  })
})
it('does not construct folded answers until opened, then keeps them available after closing', () => {
  const view = fixture('<details><summary>答案</summary>\n\n$x^2$\n\n</details>')
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(0)
  const button = screen.getByRole('button', { name: '答案' })
  fireEvent.click(button)
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(1)
  fireEvent.click(button)
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(1)
})
it('counts embedded sources once across repeated answer disclosure toggles', () => {
  const view = fixture('<details><summary>参考</summary>\n\n![[missing-image.png]]\n\n</details>')
  const button = screen.getByRole('button', { name: '参考' })
  for (let i = 0; i < 45; i++) fireEvent.click(button)
  expect(view.container.textContent).not.toContain(zh.embedCycle)
})
it('prepares offscreen formulas before native printing', () => {
  const view = fixture('First $x^2$.\n\nLater $y^2$.')
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(2)
  fireEvent(window, new Event('beforeprint'))
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(0)
})
it('completes progressive semantic chunks before native find or select-all', () => {
  const source = Array.from(
    { length: 1200 },
    (_, index) => `## Heading ${index}\n\nParagraph ${index}: course content remains intact.`,
  ).join('\n\n')
  const view = fixture(source)
  expect(view.container.querySelectorAll('[data-course-chunk-pending]').length).toBeGreaterThan(0)
  fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
  expect(view.container.querySelectorAll('[data-course-chunk-pending]').length).toBe(0)
  expect(view.container.textContent).toContain('Paragraph 1199: course content remains intact.')
})
it('prints formulas from chunks that were not mounted when printing began', () => {
  const source = Array.from({ length: 300 }, (_, index) => `## Topic ${index}\n\nFormula $x^2$.`).join('\n\n')
  const view = fixture(source)
  expect(view.container.querySelectorAll('[data-course-chunk-pending]').length).toBeGreaterThan(0)
  fireEvent(window, new Event('beforeprint'))
  expect(view.container.querySelectorAll('[data-course-chunk-pending]').length).toBe(0)
  expect(view.container.querySelectorAll('[data-course-math-pending]').length).toBe(0)
})
