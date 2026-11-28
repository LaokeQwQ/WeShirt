import cloudbase from '@cloudbase/node-sdk'
import { createSiteStoreHttpHandler } from '../../../packages/core/site-store.js'

let handler
export function main(event) {
  const app = handler ? null : cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV })
  handler ??= createSiteStoreHttpHandler({
    rdb: app.rdb(), secret: process.env.SITE_STORE_SECRET, importSecret: process.env.SITE_STORE_IMPORT_SECRET,
  })
  return handler(event)
}
