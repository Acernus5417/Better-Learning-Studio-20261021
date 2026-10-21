import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canReuseDevelopmentRuntime } from '../scripts/development-primary-runtime.ts'
import { primaryRuntimePayloadDigest } from '../../../scripts/primary-runtime/prepare.ts'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bls-development-runtime-'))
  roots.push(root)
  const inputs = { runtime: join(root, 'runtime'), officeAssets: join(root, 'office'), version: '0.1.7-rc.2',
    target: 'win-x64' as const, pnpmVersion: '11.7.0' }
  const payload = join(inputs.runtime, 'primary-runtime')
  const save = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  save(join(payload, 'runtime.json'), JSON.stringify({ desktopVersion: inputs.version, platform: 'win32', arch: 'x64',
    payloadDigest: primaryRuntimePayloadDigest(inputs.target, lock, inputs.pnpmVersion),
    python: lock.pythonVersion, node: lock.nodeVersion, pnpm: inputs.pnpmVersion, pythonPackages: lock.pythonPackages }))
  for (const relative of ['python/python.exe', 'node/bin/node.exe', 'pnpm/bin/pnpm.mjs']) {
    save(join(payload, 'dependencies', relative), 'synthetic executable')
  }
  mkdirSync(join(payload, 'dependencies/node/node_modules'))
  const libraries = join(payload, 'dependencies/python/Lib/site-packages')
  for (const [name, version] of Object.entries(lock.pythonPackages)) {
    save(join(libraries, `${name.toLowerCase().replace(/[-.]/gu, '_')}-${version}.dist-info/METADATA`),
      `Name: ${name}\nVersion: ${version}\n`)
  }
  save(join(inputs.officeAssets, 'scripts/check_office.py'), 'office scripts\n')
  save(join(inputs.runtime, 'office-skills/scripts/check_office.py'), 'office scripts\n')
  return { inputs, payload, save, libraries }
}

describe('development runtime reuse', () => {
  it('reuses complete matching resources without changing their metadata', () => {
    const { inputs, payload } = fixture()
    const before = readFileSync(join(payload, 'runtime.json'), 'utf8')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(true)
    expect(readFileSync(join(payload, 'runtime.json'), 'utf8')).toBe(before)
  })

  it('requires preparation when the release, package manager or payload identity changes', () => {
    const { inputs, payload, save } = fixture()
    expect(canReuseDevelopmentRuntime({ ...inputs, version: '0.1.8' })).toBe(false)
    expect(canReuseDevelopmentRuntime({ ...inputs, pnpmVersion: '11.8.0' })).toBe(false)
    const metadata = JSON.parse(readFileSync(join(payload, 'runtime.json'), 'utf8')) as Record<string, unknown>
    save(join(payload, 'runtime.json'), JSON.stringify({ ...metadata, payloadDigest: '0'.repeat(64) }))
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
  })

  it('rejects missing interpreters and changed Python distribution metadata', () => {
    const { inputs, payload, libraries, save } = fixture()
    const executable = join(payload, 'dependencies/python/python.exe')
    rmSync(executable)
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
    save(executable, 'restored')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(true)
    save(join(libraries, `pypdf-${lock.pythonPackages.pypdf}.dist-info/METADATA`), 'Name: pypdf\nVersion: 0.0.0\n')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
  })

  it('refreshes Office resources when the source bytes or installed file inventory differ', () => {
    const { inputs, save } = fixture()
    save(join(inputs.officeAssets, 'scripts/check_office.py'), 'new office scripts\n')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
    save(join(inputs.runtime, 'office-skills/scripts/check_office.py'), 'new office scripts\n')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(true)
    save(join(inputs.runtime, 'office-skills/obsolete.py'), 'old file')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
  })

  it('repairs missing or malformed manifests through normal preparation', () => {
    const { inputs, payload, save } = fixture()
    save(join(payload, 'runtime.json'), '{')
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
    rmSync(join(payload, 'runtime.json'))
    expect(canReuseDevelopmentRuntime(inputs)).toBe(false)
  })
})
