import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const project = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(project, '.cloudbase-build/weshirt-channel-gateway')
await mkdir(output, { recursive: true })
await build({
  entryPoints: [resolve(project, 'tools/cloudbase-fn/weshirt-channel-gateway/index.mjs')],
  outfile: resolve(output, 'index.cjs'), bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  define: { 'import.meta.url': '""' },
  footer: { js: 'if (require.main === module) module.exports.startRelay()' },
  // ws probes these optional native accelerators in try/catch; pure JS works.
  external: ['bufferutil', 'utf-8-validate'], legalComments: 'eof',
})
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'weshirt-channel-gateway', private: true, type: 'commonjs', engines: { node: '>=20.19' } }, null, 2) + '\n')
await writeFile(resolve(output, 'scf_bootstrap'), '#!/bin/sh\ncd /var/user || exit 1\nexec /var/lang/node20/bin/node index.cjs\n', { mode: 0o755 })
console.log('CloudBase WS bundle prepared: .cloudbase-build/weshirt-channel-gateway')
