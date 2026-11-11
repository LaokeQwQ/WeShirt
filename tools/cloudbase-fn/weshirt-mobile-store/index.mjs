import cloudbase from '@cloudbase/node-sdk'
import { createMobileAtomicHttpHandler } from '../../../packages/core/mobile-store.js'
import { createCloudBasePostgresAtomicStore } from '../../../packages/core/mobile-store-postgres.js'

let handler
export async function main(event) {
  if (!handler) {
    const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV })
    handler = createMobileAtomicHttpHandler({ atomicStore: createCloudBasePostgresAtomicStore(app.rdb()), secret: process.env.MOBILE_ATOMIC_STORE_SECRET })
  }
  return handler(event)
}
