/** Always-expanded heading hierarchy with visual indentation guides. */
import type { CourseDocument } from '@deepseek-ai/dsh-util-course-document'
import type { ReactElement } from 'react'
import css from './workbench.module.css'

type Heading = CourseDocument['headings'][number]
interface Branch {
  readonly heading: Heading
  readonly children: Branch[]
}
/**
 * Render every heading as a link under its nearest preceding parent.
 * @param props - Indexed headings, accessible label and existing jump command.
 * @returns A non-collapsible outline, including headings with skipped levels.
 */
export function CourseOutline({
  headings,
  label,
  open,
}: {
  readonly headings: CourseDocument['headings']
  readonly label: string
  readonly open: (start: number) => void
}) {
  const roots: Branch[] = []
  const stack: Branch[] = []
  for (const heading of headings) {
    while (stack.length > 0 && (stack.at(-1)?.heading.depth ?? 0) >= heading.depth) stack.pop()
    const branch: Branch = { heading, children: [] }
    const siblings = stack.at(-1)?.children ?? roots
    siblings.push(branch)
    stack.push(branch)
  }
  const list = (branches: readonly Branch[]): ReactElement => (
    <ul className={css.outlineList}>
      {branches.map(({ heading, children }) => (
        <li key={heading.start}>
          <button
            type="button"
            title={heading.text}
            onClick={() => {
              open(heading.start)
            }}
          >
            {heading.text}
          </button>
          {children.length > 0 && list(children)}
        </li>
      ))}
    </ul>
  )
  return (
    <nav className={css.contextContent} aria-label={label}>
      {list(roots)}
    </nav>
  )
}
