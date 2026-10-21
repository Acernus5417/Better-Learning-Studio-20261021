import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.skipIf(process.platform !== 'win32')('returns a failure and a sanitized log when a hidden startup command fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bls launcher '))
  try {
    await mkdir(join(root, 'scripts'))
    await copyFile(join(process.cwd(), 'start-studio.ps1'), join(root, 'start-studio.ps1'))
    await copyFile(join(process.cwd(), 'scripts/user-info-fallback.cjs'), join(root, 'scripts/user-info-fallback.cjs'))
    await writeFile(join(root, 'scripts/ensure-electron.mjs'),
      'console.error("https://example.invalid/?token=synthetic-secret"); process.exit(17)\n')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)))
    await expect(execute(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'start-studio.ps1'), '-SkipBuild',
    ], { env: { ...environment, APPDATA: root }, windowsHide: true })).rejects.toMatchObject({ code: 1 })
    const logs = await readdir(join(root, '.desktop-cache'))
    expect(logs).toHaveLength(1)
    const log = await readFile(join(root, '.desktop-cache', logs[0]!), 'utf8')
    expect(log).toContain('code 17')
    expect(log).toContain('[URL REDACTED]')
    expect(log).not.toContain('synthetic-secret')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
