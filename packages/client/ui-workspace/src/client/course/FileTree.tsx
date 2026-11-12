/** Course-local explorer with natural ordering and retained folder visibility. */
import type { ReactNode } from 'react'
import { useMemo, useRef, useState } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CourseFile } from '@deepseek-ai/dsh-util-course-document'
import css from './workbench.module.css'

/** One file-system row; virtual parents make imported flat inventories navigable. */
export interface CourseTreeNode {
  readonly path: string
  readonly name: string
  readonly directory: boolean
  readonly children: CourseTreeNode[]
}
/**
 * Project a flat file inventory into naturally sorted, folder-first siblings.
 * @param files - The current course's safe relative file inventory.
 * @returns Root rows with nested children.
 */
export function buildCourseTree(files: readonly CourseFile[]): CourseTreeNode[] {
  const roots: CourseTreeNode[] = []
  const nodes = new Map<string, CourseTreeNode>()
  for (const file of files) {
    const parts = file.path.split('/')
    let siblings = roots
    for (const [index, name] of parts.entries()) {
      const path = parts.slice(0, index + 1).join('/')
      let node = nodes.get(path)
      if (node === undefined) {
        node = { path, name, directory: index < parts.length - 1 || file.directory, children: [] }
        nodes.set(path, node)
        siblings.push(node)
      }
      siblings = node.children
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const sort = (rows: CourseTreeNode[]): void => {
    rows.sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name))
    for (const row of rows) sort(row.children)
  }
  sort(roots)
  return roots
}

interface TreeProps {
  readonly files: readonly CourseFile[]
  readonly selected: string
  readonly closed: readonly string[]
  readonly label: string
  readonly open: (path: string) => void
  readonly toggle: (path: string) => void
  readonly context: (path: string, rect: DOMRect) => void
}

/**
 * Hide workflow storage and retired starter entries from the reading explorer.
 * @param path - Course-relative file or folder path.
 * @returns Whether the entry belongs in the reading directory.
 */
export function visibleCourseEntry(path: string, imported = false): boolean {
  const first = path.split('/')[0]
  return first !== '_工作区' && (imported || (first !== '讲义' && first !== '附件' && path !== '课程首页.md'))
}

/** File explorer uses one tab stop and ordinary tree-key navigation. */
export function CourseFileTree({ files, selected, closed, label, open, toggle, context }: TreeProps) {
  const nodes = useMemo(() => buildCourseTree(files), [files])
  const [focused, setFocused] = useState(selected)
  const tree = useRef<HTMLUListElement>(null)
  const visible: CourseTreeNode[] = []
  const collect = (rows: readonly CourseTreeNode[]): void => {
    for (const row of rows) {
      visible.push(row)
      if (row.directory && !closed.includes(row.path)) collect(row.children)
    }
  }
  collect(nodes)
  const tabPath = visible.some(row => row.path === focused) ? focused : visible[0]?.path
  const focus = (path: string | undefined): void => {
    if (path === undefined) return
    setFocused(path)
    const button = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('button[data-tree-path]') ?? []).find(
      candidate => candidate.dataset.treePath === path,
    )
    button?.focus({ preventScroll: true })
    button?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }
  const render = (rows: readonly CourseTreeNode[], depth: number): ReactNode[] =>
    rows.map((row) => {
      const expanded = row.directory && !closed.includes(row.path)
      return (
        <li
          key={row.path}
          role="treeitem"
          aria-label={row.name}
          aria-level={depth}
          aria-selected={!row.directory && row.path === selected}
          aria-expanded={row.directory ? expanded : undefined}
        >
          <button
            type="button"
            className={css.treeRow}
            data-tree-path={row.path}
            data-selected={!row.directory && row.path === selected}
            aria-label={row.name}
            title={row.path}
            tabIndex={row.path === tabPath ? 0 : -1}
            onFocus={() => {
              setFocused(row.path)
            }}
            onClick={() => {
              if (row.directory) toggle(row.path)
              else open(row.path)
            }}
            onContextMenu={(event) => {
              if (!row.directory) {
                event.preventDefault()
                context(row.path, event.currentTarget.getBoundingClientRect())
              }
            }}
            onKeyDown={(event) => {
              const index = visible.findIndex(item => item.path === row.path)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                focus(visible[index + (event.key === 'ArrowDown' ? 1 : -1)]?.path)
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                focus(event.key === 'Home' ? visible[0]?.path : visible.at(-1)?.path)
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                if (row.directory && !expanded) toggle(row.path)
                else if (expanded) focus(row.children[0]?.path)
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                if (expanded) toggle(row.path)
                else focus(row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : undefined)
              } else if (!row.directory && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
                event.preventDefault()
                context(row.path, event.currentTarget.getBoundingClientRect())
              }
            }}
          >
            <span className={css.treeChevron} data-open={expanded || undefined} aria-hidden="true">
              {row.directory && <IconChevronRightOutlineRegular size={12} />}
            </span>
            <span className={css.treeName}>
              {row.directory ? row.name : row.name.replace(/\.(?:md|markdown)$/iu, '')}
            </span>
          </button>
          {row.directory && (
            <div className={css.treeBranch} data-open={expanded || undefined} aria-hidden={!expanded}>
              <div className={css.treeClip}>
                <ul role="group">{render(row.children, depth + 1)}</ul>
              </div>
            </div>
          )}
        </li>
      )
    })
  return (
    <ul ref={tree} className={css.fileTree} role="tree" aria-label={label}>
      {render(nodes, 1)}
    </ul>
  )
}
