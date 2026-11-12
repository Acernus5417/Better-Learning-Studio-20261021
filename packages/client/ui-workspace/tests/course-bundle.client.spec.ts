/** Packed workbench artifacts use the isolated graph instead of Cytoscape and retain notices. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps Cytoscape out of the active bundle and preserves browser-safe artifacts', () => {
  const root = resolve(import.meta.dirname, '..')
  const output = mkdtempSync(join(tmpdir(), 'bls-workbench-pack-'))
  try {
    const pnpm = process.env.npm_execpath
    if (pnpm === undefined) throw new Error('npm_execpath is required for this package test')
    const packed = spawnSync(process.execPath, [pnpm, 'pack', '--json', '--pack-destination', output], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(packed.error).toBeUndefined()
    expect(packed.status, packed.stderr).toBe(0)
    const data = JSON.parse(packed.stdout) as { files: { path: string }[] }
    const paths = data.files.map(file => file.path)
    const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
    const chunks = [...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1])
    expect(chunks.some(chunk => chunk?.includes('cytoscape'))).toBe(false)
    for (const chunk of chunks) {
      if (chunk === undefined) throw new Error('Invalid lazy chunk reference')
      expect(paths).toContain(`lib/${chunk.slice(2)}`)
      expect(readFileSync(join(root, 'lib', chunk), 'utf8')).toContain('//! Bundled course workbench license notices')
    }
    expect(client).toContain('//! Bundled course workbench license notices')
    expect(client).not.toMatch(/require\("(?:node:)?process"\)/u)
    expect(paths).toContain('THIRD-PARTY-NOTICES.txt')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
