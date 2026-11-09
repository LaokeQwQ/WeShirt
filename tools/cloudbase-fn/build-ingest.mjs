import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const project = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(project, '.cloudbase-build/weshirt-sync-ingest')
await mkdir(output, { recursive: true })
await build({
  entryPoints: [resolve(project, 'tools/cloudbase-fn/weshirt-sync-ingest/index.mjs')],
  outfile: resolve(output, 'index.js'), bundle: true, platform: 'node', target: 'node18', format: 'cjs', legalComments: 'eof',
})
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'weshirt-sync-ingest', version: '1.0.0', private: true, type: 'commonjs', main: 'index.js', engines: { node: '>=18' } }, null, 2) + '\n')
console.log('CloudBase bundle: .cloudbase-build/weshirt-sync-ingest (index.main)')
