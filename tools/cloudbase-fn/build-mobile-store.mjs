import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const project = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(project, '.cloudbase-build/weshirt-mobile-store')
await mkdir(output, { recursive: true })
await build({ entryPoints: [resolve(project, 'tools/cloudbase-fn/weshirt-mobile-store/index.mjs')], outfile: resolve(output, 'index.js'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['@cloudbase/node-sdk'], legalComments: 'eof' })
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'weshirt-mobile-store', version: '1.0.0', private: true, main: 'index.js', engines: { node: '>=22' }, dependencies: { '@cloudbase/node-sdk': '3.18.7' } }, null, 2) + '\n')
console.log('CloudBase bundle: .cloudbase-build/weshirt-mobile-store (index.main)')
