import cloudbase from '@cloudbase/node-sdk'
import { createCloudBaseMobileAtomicStore, createMobileAtomicHttpHandler } from '../../../packages/core/mobile-store.js'

let handler
export async function main(event) {
  if (!handler) {
    const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV })
    handler = createMobileAtomicHttpHandler({ atomicStore: createCloudBaseMobileAtomicStore(app.database(), { collection: process.env.MOBILE_SESSION_COLLECTION || 'weshirt_mobile_sessions' }), secret: process.env.MOBILE_ATOMIC_STORE_SECRET })
  }
  return handler(event)
}
