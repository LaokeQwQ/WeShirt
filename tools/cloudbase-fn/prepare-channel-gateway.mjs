import { access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig } from './weshirt-channel-gateway/index.mjs'

// Generate reviewable MCP requests only. This script never calls cloud APIs.
const [apiOrigin, allowedOrigins, outputDir] = process.argv.slice(2)
if (!outputDir) throw new Error('usage: node prepare-channel-gateway.mjs API_HTTPS_ORIGIN SITE_HTTPS_ORIGINS OUTPUT_DIRECTORY')
const config = loadConfig({ EDGE_API_ORIGIN: apiOrigin, COMMUNITY_WS_ALLOWED_ORIGINS: allowedOrigins })
const folder = resolve(outputDir)
await mkdir(folder, { recursive: true })
const name = 'weshirt-channel-gateway'
const functionRootPath = fileURLToPath(new URL('../../.cloudbase-build/', import.meta.url))
await access(resolve(functionRootPath, name, 'index.cjs'))
await access(resolve(functionRootPath, name, 'scf_bootstrap'))
const create = {
  name: 'manageFunctions',
  arguments: {
    action: 'createFunction',
    functionRootPath,
    func: {
      name, type: 'HTTP', runtime: 'Nodejs20.19', timeout: 150,
      protocolType: 'WS', protocolParams: { wsParams: { idleTimeOut: 35 } },
      instanceConcurrencyConfig: { dynamicEnabled: false, maxConcurrency: 1 },
      envVariables: { EDGE_API_ORIGIN: config.apiOrigin, COMMUNITY_WS_ALLOWED_ORIGINS: [...config.origins].join(',') },
      isWaitInstall: false,
    },
  },
}
const route = {
  name: 'manageGateway',
  arguments: {
    action: 'createRoute', targetName: name, upstreamResourceType: 'WEB_SCF',
    path: `/${name}`, auth: false, enablePathTransmission: false,
    qpsPolicy: { total: 100, perClient: { limitBy: 'ClientIP', limitValue: 10 } },
  },
}
await writeFile(resolve(folder, 'create-function.json'), JSON.stringify(create, null, 2) + '\n')
await writeFile(resolve(folder, 'create-route.json'), JSON.stringify(route, null, 2) + '\n')
console.log('Prepared two deployment requests; no cloud changes made.')
