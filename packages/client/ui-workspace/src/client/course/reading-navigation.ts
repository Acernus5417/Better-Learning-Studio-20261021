/** Preserve the current scroll origin until deferred formula heights before the target are known. */
export function afterCourseMath(scroller: HTMLElement, offset: number, navigate: () => void): () => void {
  let frame: number | undefined
  const ready = (): void => {
    const pending = Array.from(scroller.querySelectorAll<HTMLElement>('[data-course-math-pending]')).some(
      element =>
        element.closest('[data-course-document]') === scroller && Number(element.dataset.sourceStart) <= offset,
    )
    const chunks = Array.from(scroller.querySelectorAll<HTMLElement>('[data-course-chunk-pending]')).some(
      element =>
        element.closest('[data-course-document]') === scroller && Number(element.dataset.courseChunkStart) <= offset,
    )
    if (pending || chunks) frame = requestAnimationFrame(ready)
    else navigate()
  }
  ready()
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
