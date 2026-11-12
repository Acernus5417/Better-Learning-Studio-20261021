/** Local Markdown destinations accepted by the file-preview callback. */

/**
 * Decode a local path or local file URL and its line or heading fragment.
 * Literal `?` and `#` in filenames must be percent-encoded.
 * @param value - Parsed Markdown link destination.
 * @returns A local path and optional first line, or undefined for URLs,
 * fragment-only links, remote file hosts, queries, malformed escapes, or invalid line ranges.
 */
export function parseFileLink(value: string): { path: string; line?: number; anchor?: string } | undefined {
  const hash = value.indexOf('#')
  let destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  if (/^file:/iu.test(destination)) {
    try {
      const url = new URL(destination)
      if (url.host !== '' && url.host !== 'localhost') return undefined
      destination = url.pathname.replace(/^\/(?=[a-z]:\/)/iu, '')
    } catch (_error) {
      // A malformed file URL cannot identify a local destination.
      return undefined
    }
  }
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch (_error) {
    // Malformed percent escapes cannot identify a file unambiguously.
    return undefined
  }
  if (
    path.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /^[\\/]{2}/.test(path) ||
    (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
  )
    return undefined
  if (hash < 0) return { path }
  let fragment: string
  try {
    fragment = decodeURIComponent(value.slice(hash + 1))
  } catch (_error) {
    return undefined
  }
  if (fragment === '') return { path }
  if (/[\u0000-\u001f\u007f]/u.test(fragment)) return undefined
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(fragment)
  if (match === null) return /^L\d/u.test(fragment) ? undefined : { path, anchor: fragment }
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return undefined
  return { path, line }
}
