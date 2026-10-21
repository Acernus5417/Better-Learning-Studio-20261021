/** Reuse complete, lock-matching development resources before opening Electron. */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { primaryRuntimePayloadDigest } from '../../../scripts/primary-runtime/prepare.ts'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths, desktopTargetPlatform } from './desktop-build-paths.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'

interface DevelopmentRuntimeInputs {
  readonly runtime: string
  readonly officeAssets: string
  readonly version: string
  readonly target: ReturnType<typeof resolveDesktopBuildTarget>
  readonly pnpmVersion: string
}

function treeDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const name = `${prefix}/${entry.name}`
      if (entry.isDirectory()) { hash.update(`directory:${name}\0`); visit(path, name) }
      else if (entry.isFile()) { hash.update(`file:${name}\0`); hash.update(readFileSync(path)); hash.update('\0') }
      else throw new Error('desktop development: Office assets must be ordinary files and directories')
    }
  }
  visit(root, '')
  return hash.digest('hex')
}

/**
 * Check pinned versions, executable/library entries, distribution metadata and Office asset bytes.
 * @param inputs - Build-owned resource locations and current package versions.
 * @returns Whether development can reuse resources without unpacking or running packaging smokes.
 */
export function canReuseDevelopmentRuntime(inputs: DevelopmentRuntimeInputs): boolean {
  try {
    const root = join(inputs.runtime, 'primary-runtime')
    const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
    const target = desktopTargetPlatform(inputs.target)
    if (manifest.desktopVersion !== inputs.version || manifest.platform !== target.platform || manifest.arch !== target.arch
      || manifest.payloadDigest !== primaryRuntimePayloadDigest(inputs.target, lock, inputs.pnpmVersion)
      || manifest.python !== lock.pythonVersion || manifest.node !== lock.nodeVersion || manifest.pnpm !== inputs.pnpmVersion
      || Object.keys(manifest.pythonPackages).length !== Object.keys(lock.pythonPackages).length
      || Object.entries(lock.pythonPackages).some(([name, version]) => manifest.pythonPackages[name] !== version)) return false
    const paths = workspaceDependencyPaths(root, manifest)
    for (const path of [paths.python, paths.node, paths.pnpm]) {
      if (path === undefined || !statSync(path).isFile()) return false
    }
    if (!statSync(paths.pythonPackages).isDirectory()
      || paths.nodePackages === undefined || !statSync(paths.nodePackages).isDirectory()) return false
    for (const [name, version] of Object.entries(lock.pythonPackages)) {
      const metadata = `${name.toLowerCase().replace(/[-.]/gu, '_')}-${version}.dist-info/METADATA`
      const content = readFileSync(join(paths.pythonPackages, metadata), 'utf8')
      const distribution = /^Name: (.+)$/mu.exec(content)?.[1]?.trim().toLowerCase().replace(/[-_.]+/gu, '-')
      if (distribution !== name.toLowerCase().replace(/[-_.]+/gu, '-')
        || /^Version: (.+)$/mu.exec(content)?.[1]?.trim() !== version) return false
    }
    return treeDigest(inputs.officeAssets) === treeDigest(join(inputs.runtime, 'office-skills'))
  } catch (error) {
    // Missing, malformed or incomplete development resources require normal preparation.
    if (error instanceof Error) return false
    throw error
  }
}

/** Prepare development resources only when their pinned inputs or required files changed. */
export async function prepareDevelopmentPrimaryRuntime(): Promise<void> {
  const require = createRequire(import.meta.url)
  const paths = resolveDesktopTargetBuildPaths()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const { version: pnpmVersion } = JSON.parse(readFileSync(require.resolve('pnpm'), 'utf8')) as { version: string }
  const officeAssets = join(require.resolve('@deepseek-ai/dsh-skill-office/package.json'), '..', 'assets')
  if (canReuseDevelopmentRuntime({ runtime: paths.runtime, officeAssets, version,
    target: resolveDesktopBuildTarget(), pnpmVersion })) {
    console.log('desktop development: reusing verified runtime resources')
    return
  }
  console.log('desktop development: preparing runtime resources; this first preparation can take a minute')
  await preparePrimaryRuntime()
}
