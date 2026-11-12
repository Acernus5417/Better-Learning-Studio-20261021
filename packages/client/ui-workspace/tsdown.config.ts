import { clientBundle } from '../tsdown.client.ts'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const yamlBrowser = join(dirname(createRequire(import.meta.url).resolve('yaml/package.json')), 'browser', 'index.js')

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  clientAliases: { yaml: yamlBrowser },
  clientBanner: () => [
    '//! Bundled course workbench license notices',
    ...readFileSync(join(import.meta.dirname, 'THIRD-PARTY-NOTICES.txt'), 'utf8').trimEnd().split('\n').map(line => `// ${line}`),
  ].join('\n'),
})
